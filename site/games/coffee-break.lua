-- Coffee Break: stop the pour inside the cup.
game = {
  id = "coffee-break",
  name = "Coffee Break",
  genre = "Timing",
  tagline = "Stop the pour at exactly the right moment.",
  duration = 30,
  min_size = { w = 40, h = 9 },
  controls = {
    { "Space", "stop the pour" },
  },
}

local W = 36
local pos, dir, cups, spills, streak, best, lives
local zone_x, zone_w

function new_zone()
  local base = ({ easy = 10, normal = 8, hard = 6 })[vb.difficulty]
  zone_w = math.max(2, base - math.floor(cups / 3))
  zone_x = vb.randint(0, W - zone_w)
end

function init()
  pos, dir = 0, 1
  cups, spills, streak, best = 0, 0, 0, 0
  lives = vb.lives or 5
  new_zone()
end

function update(dt)
  pos = pos + dir * dt / 1000 * (18 + cups * 1.5) * vb.speed
  if pos >= W - 1 then pos, dir = W - 1, -1
  elseif pos <= 0 then pos, dir = 0, 1 end
end

function on_key(key)
  if key.name ~= "space" then return end
  local p = math.floor(pos)
  if p >= zone_x and p < zone_x + zone_w then
    cups = cups + 1
    streak = streak + 1
    best = math.max(best, streak)
    local center = zone_x + (zone_w - 1) / 2
    local pts = 50 + streak * 10
    if math.abs(p - center) < 1 then
      pts = pts * 2
      vb.flash("PERFECT POUR", "gold")
    end
    vb.score(pts)
  else
    spills = spills + 1
    streak = 0
    lives = lives - 1
    vb.penalize(30)
    vb.flash("Spilled!", "bad")
    if lives <= 0 then
      vb.finish("gameover")
      return
    end
  end
  new_zone()
end

function render()
  local p = math.floor(pos)
  local bar, marker = {}, {}
  for i = 0, W - 1 do
    local inside = i >= zone_x and i < zone_x + zone_w
    bar[#bar + 1] = inside and "{good}={/}" or "-"
    marker[#marker + 1] = i == p and "{gold}V{/}" or " "
  end
  return {
    "",
    "  " .. table.concat(marker),
    "  " .. table.concat(bar),
    "",
    "        ( (",
    "         ) )     cups poured: " .. cups,
    "      ........   streak: " .. streak,
    "      |      |]",
    "      `------'",
  }
end

function hud()
  return {
    { label = "LIVES", value = tostring(lives), tone = lives <= 1 and "bad" or nil },
    { label = "CUPS", value = tostring(cups) },
  }
end

function metrics()
  return { { "Cups poured", tostring(cups) }, { "Spills", tostring(spills) }, { "Best streak", tostring(best) } }
end

function perfect()
  return cups >= 5 and spills == 0
end
