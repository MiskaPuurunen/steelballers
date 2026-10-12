-- Key Rain: zap falling keys by typing them.
game = {
  id = "key-rain",
  name = "Key Rain",
  genre = "Typing",
  tagline = "Zap falling keys before they hit the floor.",
  duration = 40,
  min_size = { w = 30, h = 14 },
  controls = {
    { "A S D F J K L", "zap the lowest matching key" },
  },
}

local KEYS = { "a", "s", "d", "f", "j", "k", "l" }
local W, H = 28, 12
local drops, spawn_in, zapped, missed, wrong, lives

function init()
  drops, spawn_in = {}, 0
  zapped, missed, wrong = 0, 0, 0
  lives = vb.lives or 5
end

function update(dt)
  spawn_in = spawn_in - dt * vb.speed
  if spawn_in <= 0 then
    drops[#drops + 1] = {
      k = KEYS[vb.randint(1, #KEYS)],
      x = vb.randint(0, W - 1),
      y = 0,
      gold = vb.chance(0.1 * vb.special),
    }
    local base = ({ easy = 1100, normal = 850, hard = 650 })[vb.difficulty]
    spawn_in = math.max(350, base - vb.elapsed() / 40)
  end
  local fall = dt / 1000 * 2.2 * vb.speed
  for i = #drops, 1, -1 do
    local d = drops[i]
    d.y = d.y + fall
    if d.y >= H then
      table.remove(drops, i)
      missed = missed + 1
      lives = lives - 1
      vb.flash("Missed " .. d.k:upper(), "bad")
      if lives <= 0 then vb.finish("gameover") end
    end
  end
end

function on_key(key)
  local ch = key.ch and key.ch:lower()
  if not ch or key.name ~= "char" then return end
  local best, bi = -1, nil
  for i, d in ipairs(drops) do
    if d.k == ch and d.y > best then best, bi = d.y, i end
  end
  if bi then
    local d = table.remove(drops, bi)
    zapped = zapped + 1
    local pts = 10 + math.floor((H - d.y) * 5)
    if d.gold then
      pts = pts * 3
      vb.flash("GOLD +" .. pts, "gold")
    end
    vb.score(pts)
  else
    wrong = wrong + 1
    vb.penalize(15)
  end
end

function render()
  local grid = {}
  for r = 0, H - 1 do
    grid[r] = {}
    for c = 0, W - 1 do grid[r][c] = " " end
  end
  for _, d in ipairs(drops) do
    local r = math.floor(d.y)
    grid[r][d.x] = d.gold and ("{gold}" .. d.k:upper() .. "{/}") or ("{info}" .. d.k .. "{/}")
  end
  local rows = {}
  for r = 0, H - 1 do
    rows[#rows + 1] = "|" .. table.concat(grid[r], "", 0, W - 1) .. "|"
  end
  rows[#rows + 1] = "+" .. string.rep("=", W) .. "+"
  return rows
end

function hud()
  return {
    { label = "LIVES", value = tostring(lives), tone = lives <= 1 and "bad" or nil },
    { label = "ZAPPED", value = tostring(zapped) },
  }
end

function metrics()
  return { { "Keys zapped", tostring(zapped) }, { "Keys missed", tostring(missed) }, { "Wrong keys", tostring(wrong) } }
end

function perfect()
  return zapped > 0 and missed == 0 and wrong == 0
end
