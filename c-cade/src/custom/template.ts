/**
 * Starter game offered by "New from template" in the Custom Games screen.
 * It doubles as a working reference for the whole Lua API.
 */
export const TEMPLATE_LUA = `-- Packet Catcher: an example C-Cade game.
-- Full API reference: docs/CUSTOM_GAMES.md

game = {
  id = "packet-catcher",            -- lowercase letters, digits, dashes
  name = "Packet Catcher",
  genre = "Reflex",
  tagline = "Catch the good packets, dodge the malware.",
  min_size = { w = 32, h = 14 },    -- size of what render() draws
  controls = {
    { "Left/Right, A/D", "move the firewall" },
  },
}

local LANES, SKY, LANE_W = 5, 12, 6
local paddle, packets, spawn_in = 3, {}, 0
local caught, missed, infected, lives

function init()
  -- vb.lives is set by the Low Battery modifier, otherwise nil.
  lives = vb.lives or 5
  caught, missed, infected = 0, 0, 0
end

local function spawn()
  local bad_chance = 0.25 * vb.special
  packets[#packets + 1] = { lane = vb.randint(1, LANES), y = 0, bad = vb.chance(bad_chance) }
end

function update(dt)
  local interval = ({ easy = 900, normal = 700, hard = 500 })[vb.difficulty]
  spawn_in = spawn_in - dt * vb.speed
  if spawn_in <= 0 then
    spawn()
    spawn_in = interval
  end

  local fall = dt / 1000 * 6 * vb.speed
  for i = #packets, 1, -1 do
    local p = packets[i]
    p.y = p.y + fall
    if p.y >= SKY then
      table.remove(packets, i)
      if p.lane == paddle then
        if p.bad then
          infected = infected + 1
          lives = lives - 1
          vb.penalize(50)
          vb.flash("MALWARE!", "bad")
          if lives <= 0 then vb.finish("gameover") end
        else
          caught = caught + 1
          vb.score(50)
        end
      elseif not p.bad then
        -- There is no clock: dropping a good packet costs a life too.
        missed = missed + 1
        lives = lives - 1
        vb.flash("DROPPED!", "bad")
        if lives <= 0 then vb.finish("gameover") end
      end
    end
  end
end

function on_key(key)
  local ch = key.ch and key.ch:lower()
  if key.name == "left" or ch == "a" or ch == "h" then
    paddle = math.max(1, paddle - 1)
  elseif key.name == "right" or ch == "d" or ch == "l" then
    paddle = math.min(LANES, paddle + 1)
  end
end

function render()
  local rows = {}
  for r = 0, SKY - 1 do
    local cells = {}
    for lane = 1, LANES do cells[lane] = "      " end
    for _, p in ipairs(packets) do
      if math.floor(p.y) == r then
        cells[p.lane] = p.bad and " {bad}[!!]{/} " or " {good}[OK]{/} "
      end
    end
    rows[#rows + 1] = "|" .. table.concat(cells) .. "|"
  end
  local floor = {}
  for lane = 1, LANES do
    floor[lane] = lane == paddle and "{info}======{/}" or "      "
  end
  rows[#rows + 1] = "|" .. table.concat(floor) .. "|"
  rows[#rows + 1] = "+" .. string.rep("-", LANES * LANE_W) .. "+"
  return rows
end

function hud()
  return {
    { label = "LIVES", value = tostring(lives), tone = lives <= 1 and "bad" or nil },
    { label = "CAUGHT", value = tostring(caught) },
  }
end

function metrics()
  return {
    { "Packets caught", tostring(caught) },
    { "Packets missed", tostring(missed) },
    { "Malware let in", tostring(infected) },
  }
end

function perfect()
  return caught > 0 and missed == 0 and infected == 0
end
`;
