-- Ping: solo pong. Keep the packet bouncing.
game = {
  id = "ping",
  name = "Ping",
  genre = "Arcade",
  tagline = "Keep the packet alive. Every bounce scores more.",
  duration = 45,
  min_size = { w = 32, h = 14 },
  controls = {
    { "Left/Right, A/D", "move the paddle" },
  },
}

local W, H = 30, 12
local px, pw, bx, by, vx, vy
local bounces, misses, lives

function reset_ball()
  bx, by = W / 2, 1
  vx = (vb.chance(0.5) and -1 or 1) * 8
  vy = 7
end

function init()
  pw = ({ easy = 8, normal = 6, hard = 4 })[vb.difficulty]
  px = math.floor((W - pw) / 2)
  bounces, misses = 0, 0
  lives = vb.lives or 3
  reset_ball()
end

function update(dt)
  local s = dt / 1000 * vb.speed
  bx = bx + vx * s
  by = by + vy * s
  if bx < 0 then bx = -bx; vx = -vx end
  if bx > W - 1 then bx = 2 * (W - 1) - bx; vx = -vx end
  if by < 0 then by = -by; vy = -vy end
  if by >= H - 1 then
    local col = math.floor(bx)
    if col >= px and col < px + pw then
      by = H - 1.01
      vy = -math.min(20, math.abs(vy) * 1.05)
      vx = math.max(-20, math.min(20, vx * 1.03))
      bounces = bounces + 1
      vb.score(10 + 5 * bounces)
    else
      misses = misses + 1
      lives = lives - 1
      vb.flash("Packet lost!", "bad")
      if lives <= 0 then vb.finish("gameover") else reset_ball() end
    end
  end
end

function on_key(key)
  local ch = key.ch and key.ch:lower()
  if key.name == "left" or ch == "a" or ch == "h" then
    px = math.max(0, px - 2)
  elseif key.name == "right" or ch == "d" or ch == "l" then
    px = math.min(W - pw, px + 2)
  end
end

function render()
  local rows = { "+" .. string.rep("-", W) .. "+" }
  for r = 0, H - 2 do
    local line = string.rep(" ", W)
    if math.floor(by) == r then
      local c = math.floor(bx)
      line = line:sub(1, c) .. "{gold}o{/}" .. line:sub(c + 2)
    end
    rows[#rows + 1] = "|" .. line .. "|"
  end
  rows[#rows + 1] = "|" .. string.rep(" ", px) .. "{info}" .. string.rep("=", pw) .. "{/}" .. string.rep(" ", W - px - pw) .. "|"
  return rows
end

function hud()
  return {
    { label = "LIVES", value = tostring(lives), tone = lives <= 1 and "bad" or nil },
    { label = "RALLY", value = tostring(bounces) },
  }
end

function metrics()
  return { { "Bounces", tostring(bounces) }, { "Packets lost", tostring(misses) } }
end

function perfect()
  return misses == 0 and bounces >= 10
end
