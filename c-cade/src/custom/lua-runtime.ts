

const STEP_INSTRUCTIONS = 1000;
/** Budget for one update/key/render call (about 5-10 ms of Lua). */
const CALL_BUDGET = 500_000;
/** Budget for loading the script and running init(). */
const LOAD_BUDGET = 10_000_000;
/** Wall-clock (CPU seconds) caps, for calls that spend their time inside C functions. */
const CALL_SECONDS = 0.05;
const LOAD_SECONDS = 1;
/** Memory cap per game engine. */
const MEMORY_MAX_BYTES = 32 * 1024 * 1024;
const BUDGET_MESSAGE = 'script ran too long (instruction budget exceeded)';

/** Host callbacks a game engine can reach through the `vb` table. */
interface HostFunctions {
  score(n: number): number;
  penalize(n: number): number;
  flash(text: string, tone: string, ms: number): void;
  finish(reason: string): void;
  random(): number;
  elapsed(): number;
  getScore(): number;
}

export interface LuaVm {
  /**
   * Call an operation of the sandbox dispatcher. Returns the result string, or
   * throws an Error with the Lua error message.
   */
  call(op: string, a?: string | number | boolean, b?: string | number | boolean, c?: string | number | boolean): string;
  close(): void;
}

export interface LuaRuntime {
  createVm(host: HostFunctions): LuaVm;
}

/* ------------------------------------------------------------- prelude */

/**
 * Runs once per engine with the full standard library, captures what it needs
 * as locals, builds the sandbox environment and removes everything else.
 */
const PRELUDE = String.raw`
local H = __vb_host
__vb_host = nil

local debug_sethook = debug.sethook
local pcall_raw, xpcall_raw, error_raw = pcall, xpcall, error
local load_raw, type_raw, pairs_raw, tostring_raw = load, type, pairs, tostring
local co_create, co_resume = coroutine.create, coroutine.resume
local tpack, tunpack, tconcat = table.pack, table.unpack, table.concat
local tonumber_raw, ipairs_raw = tonumber, ipairs
local sgsub, sgmatch, smatch, floor = string.gsub, string.gmatch, string.match, math.floor

local LIMIT = "${BUDGET_MESSAGE}"
local STEP = ${STEP_INSTRUCTIONS}
local clock = os.clock
local used, budget, exceeded, deadline = 0, 0, false, 0

local function hook()
  used = used + 1
  if used > budget or clock() > deadline then
    exceeded = true
    error_raw(LIMIT, 0)
  end
end

-- Once the budget is blown, keep unwinding through any pcall the script set up.
local function guard(...)
  if exceeded then error_raw(LIMIT, 0) end
  return ...
end
local function safe_pcall(f, ...) return guard(pcall_raw(f, ...)) end
local function safe_xpcall(f, h, ...) return guard(xpcall_raw(f, h, ...)) end

-- Hooks are per coroutine: install ours on every coroutine the script makes.
local function co_create_hooked(f)
  local co = co_create(f)
  debug_sethook(co, hook, "", STEP)
  return co
end
local function co_resume_guarded(co, ...) return guard(co_resume(co, ...)) end
local function co_wrap(f)
  local co = co_create_hooked(f)
  return function(...)
    local r = tpack(co_resume_guarded(co, ...))
    if not r[1] then error_raw(r[2], 0) end
    return tunpack(r, 2, r.n)
  end
end

local function copy(t, skip)
  local r = {}
  for k, v in pairs_raw(t) do
    if not (skip and skip[k]) then r[k] = v end
  end
  return r
end

-- The shared string metatable would otherwise let scripts patch string methods.
getmetatable("").__metatable = false
string.dump = nil

local vb = {
  score = function(n) return H.score(tonumber_raw(n) or 0) end,
  penalize = function(n) return H.penalize(tonumber_raw(n) or 0) end,
  flash = function(text, tone, ms) H.flash(tostring_raw(text or ""), tostring_raw(tone or "info"), tonumber_raw(ms) or 900) end,
  finish = function(reason) H.finish(tostring_raw(reason or "gameover")) end,
  random = function() return H.random() end,
  randint = function(a, b)
    a, b = floor(tonumber_raw(a) or 0), floor(tonumber_raw(b) or 0)
    if b < a then a, b = b, a end
    return a + floor(H.random() * (b - a + 1))
  end,
  chance = function(p) return H.random() < (tonumber_raw(p) or 0) end,
  time_left = function() return 1 / 0 end, -- rounds have no clock: math.huge
  elapsed = function() return H.elapsed() end,
  get_score = function() return H.getScore() end,
}

local env = {
  assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs,
  pcall = safe_pcall, xpcall = safe_xpcall, select = select,
  tonumber = tonumber, tostring = tostring, type = type,
  rawequal = rawequal, rawget = rawget, rawlen = rawlen, rawset = rawset,
  setmetatable = setmetatable, getmetatable = getmetatable,
  unpack = table.unpack,
  print = function() end,
  math = copy(math, { random = true, randomseed = true }),
  string = copy(string),
  table = copy(table),
  utf8 = copy(utf8),
  coroutine = {
    create = co_create_hooked, resume = co_resume_guarded, wrap = co_wrap,
    yield = coroutine.yield, status = coroutine.status,
    running = coroutine.running, isyieldable = coroutine.isyieldable,
  },
  vb = vb,
}
env._G = env

-- Wipe the real globals: from here on only the dispatcher can reach the host.
for k in pairs_raw(copy(_G)) do
  if k ~= "_G" then _G[k] = nil end
end

local function clean(s)
  return (sgsub(tostring_raw(s), "%c", " "))
end

local function field(t, k)
  if type_raw(t) ~= "table" then return nil end
  return t[k]
end

local function serialize_lines(v, max)
  if type_raw(v) == "string" then return v end
  if type_raw(v) ~= "table" then return "" end
  local out = {}
  for i = 1, max do
    local line = v[i]
    if line == nil then break end
    out[i] = tostring_raw(line)
  end
  return tconcat(out, "\n")
end

local function serialize_pairs(v, max, keys)
  if type_raw(v) ~= "table" then return "" end
  local out = {}
  for i = 1, max do
    local item = v[i]
    if type_raw(item) ~= "table" then break end
    local cells = {}
    for j, k in ipairs_raw(keys) do
      local cell = item[k]
      if cell == nil then cell = item[j] end
      cells[j] = cell == nil and "" or clean(cell)
    end
    out[i] = tconcat(cells, "\t")
  end
  return tconcat(out, "\n")
end

local function meta()
  local g = env.game
  if type_raw(g) ~= "table" then error_raw("the script must define a global table named 'game'", 0) end
  local out = {}
  for _, k in ipairs_raw({ "id", "name", "genre", "tagline", "duration" }) do
    local v = g[k]
    if v ~= nil then out[#out + 1] = k .. "\t" .. clean(v) end
  end
  local size = g.min_size
  out[#out + 1] = "width\t" .. clean(field(size, "w") or field(size, 1) or "")
  out[#out + 1] = "height\t" .. clean(field(size, "h") or field(size, 2) or "")
  local controls = g.controls
  if type_raw(controls) == "table" then
    for i = 1, 8 do
      local c = controls[i]
      if type_raw(c) ~= "table" then break end
      out[#out + 1] = "control\t" .. clean(c[1] or c.keys or "") .. "\t" .. clean(c[2] or c.action or "")
    end
  end
  return tconcat(out, "\n")
end

local function call_user(name, ...)
  local f = env[name]
  if type_raw(f) ~= "function" then return nil end
  return f(...)
end

local ops = {
  load = function(src)
    local fn, err = load_raw(src, "=game", "t", env)
    if not fn then error_raw(err, 0) end
    fn()
    return meta()
  end,
  ctx = function(difficulty, encoded)
    vb.difficulty = difficulty
    for pair in sgmatch(encoded, "[^;]+") do
      local k, v = smatch(pair, "^([%w_]+)=(.*)$")
      if v == "true" then vb[k] = true
      elseif v == "false" then vb[k] = false
      elseif v ~= "nil" then vb[k] = tonumber_raw(v) end
    end
    return ""
  end,
  init = function() call_user("init") return "" end,
  update = function(dt) call_user("update", dt) return "" end,
  key = function(name, ch, ctrl)
    local k = { name = name, ctrl = ctrl or false }
    if ch ~= "" then k.ch = ch end
    call_user("on_key", k)
    return ""
  end,
  render = function() return serialize_lines(call_user("render"), 64) end,
  hud = function() return serialize_pairs(call_user("hud"), 6, { "label", "value", "tone" }) end,
  metrics = function() return serialize_pairs(call_user("metrics"), 8, { "label", "value" }) end,
  perfect = function() return call_user("perfect") == true and "1" or "0" end,
}

function __vb_dispatch(limit, seconds, op, a, b, c)
  local f = ops[op]
  if not f then return "0unknown op " .. tostring_raw(op) end
  used, budget, exceeded, deadline = 0, limit // STEP, false, clock() + seconds
  debug_sethook(hook, "", STEP)
  local ok, res = pcall_raw(f, a, b, c)
  debug_sethook()
  exceeded = false
  if ok then return "1" .. tostring_raw(res or "") end
  return "0" .. tostring_raw(res)
end
`;

/* ------------------------------------------------------------- loading */

let runtimePromise: Promise<LuaRuntime> | null = null;

/** Load the Lua WASM runtime once. Rejects with a friendly message if missing. */
export function loadLuaRuntime(): Promise<LuaRuntime> {
  runtimePromise ??= (async () => {
    let wasmoon: typeof import('wasmoon');
    try {
      wasmoon = await import('wasmoon');
    } catch {
      runtimePromise = null;
      throw new Error('The Lua runtime is not installed. Run: npm install wasmoon');
    }
    const module = await new wasmoon.LuaFactory().getLuaModule();
    const runtime: LuaRuntime = {
      createVm(host) {
        const engine = new wasmoon.LuaEngine(module, { traceAllocations: true, injectObjects: false });
        engine.global.setMemoryMax(MEMORY_MAX_BYTES);
        // Host functions are exposed as one table, captured by the prelude and
        // then removed from the globals.
        engine.global.set('__vb_host', {
          score: (n: unknown) => host.score(num(n)),
          penalize: (n: unknown) => host.penalize(num(n)),
          flash: (t: unknown, tone: unknown, ms: unknown) => host.flash(String(t), String(tone), num(ms)),
          finish: (r: unknown) => host.finish(String(r)),
          random: () => host.random(),
          elapsed: () => host.elapsed(),
          getScore: () => host.getScore(),
        });
        engine.doStringSync(PRELUDE);
        const dispatch = engine.global.get('__vb_dispatch') as (...args: unknown[]) => unknown;
        let closed = false;
        return {
          call(op, a = '', b = '', c = '') {
            if (closed) throw new Error('game engine is closed');
            const heavy = op === 'load' || op === 'init';
            const out = String(dispatch(heavy ? LOAD_BUDGET : CALL_BUDGET, heavy ? LOAD_SECONDS : CALL_SECONDS, op, a, b, c) ?? '0no result');
            if (out.startsWith('1')) return out.slice(1);
            throw new Error(out.slice(1) || 'unknown Lua error');
          },
          close() {
            if (closed) return;
            closed = true;
            try {
              engine.global.close();
            } catch {
              /* already gone */
            }
          },
        };
      },
    };
    return runtime;
  })();
  return runtimePromise;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
