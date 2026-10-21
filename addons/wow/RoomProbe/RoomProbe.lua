local addonName = ...
local frame = CreateFrame("Frame")
local watching = false
local blueprintLabel
local panel, editBox
local namespaces = { "C_HousingDecor", "C_HousingExpertMode", "C_HousingBasicMode",
    "C_HousingLayout", "C_HouseEditor", "C_HousingBlueprint", "C_HousingCustomizeMode" }
local eventNames = {
    "HOUSING_DECOR_SELECTED", "HOUSING_DECOR_DESELECTED",
    "HOUSING_DECOR_PLACED", "HOUSING_DECOR_REMOVED",
    "HOUSING_DECOR_CUSTOMIZATION_CHANGED", "HOUSING_DECOR_PRECISION_SUBMODE_CHANGED",
    "HOUSE_EDITOR_MODE_CHANGED", "HOUSING_LAYOUT_ROOM_SELECTED",
    "HOUSING_BLUEPRINT_CONTENTS_RECEIVED", "HOUSING_BLUEPRINT_CONTENTS_FAILURE",
    "HOUSING_BLUEPRINT_EXPORT_SUCCESS", "HOUSING_BLUEPRINT_EXPORT_FAILURE",
}
local function say(message)
    print("|cff77ccffRoomProbe:|r " .. message)
end
local function secret(value)
    return issecretvalue and issecretvalue(value)
end

-- Copy plain data only. Never unwrap secret values or invoke object methods.
local function copy(value, seen, depth, budget)
    if secret(value) then return "<secret value omitted>" end
    local kind = type(value)
    if kind == "nil" then return "<nil>" end
    if kind == "string" then return value:sub(1, 16000) end
    if kind == "boolean" then return value end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return "<nonfinite>" end
        return value
    end
    if kind ~= "table" then return "<" .. kind .. ">" end
    seen, depth, budget = seen or {}, depth or 0, budget or { n = 0 }
    if seen[value] then return "<cycle>" end
    if depth >= 12 then return "<depth limit>" end
    seen[value] = true
    local result, count = {}, 0
    for key, entry in pairs(value) do
        count, budget.n = count + 1, budget.n + 1
        if count > 1000 or budget.n > 10000 then result.__truncated = true; break end
        if not secret(key) and (type(key) == "string" or type(key) == "number") then
            result[tostring(key)] = copy(entry, seen, depth + 1, budget)
        end
    end
    seen[value] = nil
    return result
end
local function safeCopy(value)
    local ok, result = pcall(copy, value)
    if ok then return result end
    return "<data could not be read>"
end
local function call(namespace, method, ...)
    local api = _G[namespace]
    if type(api) ~= "table" or type(api[method]) ~= "function" then return { status = "unavailable" } end
    local function pack(...) return { n = select("#", ...), ... } end
    local result = pack(pcall(api[method], ...))
    if not result[1] then return { status = "error", detail = safeCopy(result[2]) } end
    local values = {}
    for i = 2, result.n do values[tostring(i - 1)] = safeCopy(result[i]) end
    return { status = "ok", returnCount = result.n - 1, values = values }
end
local function boundedInsert(list, value, limit)
    list[#list + 1] = value
    if #list > limit then table.remove(list, 1) end
end
local function discover()
    local result = {}
    local discovered = {}
    for _, namespace in ipairs(namespaces) do discovered[namespace] = true end
    -- Discover names only; never invoke unknown functions.
    for name, value in pairs(_G) do
        if type(name) == "string" and name:match("^C_Hous") and type(value) == "table" then
            discovered[name] = true
        end
    end
    for namespace in pairs(discovered) do
        local names = {}
        if type(_G[namespace]) == "table" then
            for name, member in pairs(_G[namespace]) do
                if type(name) == "string" and type(member) == "function" then names[#names + 1] = name end
            end
            table.sort(names)
        end
        result[namespace] = names
    end
    RoomProbeDB.api = result
end
local function capture(label, quiet)
    if InCombatLockdown and InCombatLockdown() then
        if not quiet then say("Capture skipped during combat.") end
        return
    end
    discover()
    local sample = { time = date("!%Y-%m-%dT%H:%M:%SZ"), label = label or "manual", queries = {} }
    local getters = {
        { "C_HousingDecor", "GetSelectedDecorInfo" },
        { "C_HousingDecor", "GetHoveredDecorInfo" },
        { "C_HousingDecor", "GetNumDecorPlaced" },
        { "C_HousingExpertMode", "GetSelectedDecorInfo" },
        { "C_HousingExpertMode", "GetHoveredDecorInfo" },
        { "C_HousingExpertMode", "GetPrecisionSubmode" },
        { "C_HouseEditor", "GetActiveHouseEditorMode" },
    }
    local guids = {}
    for _, getter in ipairs(getters) do
        local key = getter[1] .. "." .. getter[2]
        local result = call(getter[1], getter[2])
        sample.queries[key] = result
        local info = result.values and result.values["1"]
        if type(info) == "table" and type(info.decorGUID) == "string" and info.decorGUID:sub(1, 1) ~= "<" then
            guids[info.decorGUID] = true
        end
    end
    for guid in pairs(guids) do
        sample.queries["GetDecorInstanceInfoForGUID:" .. guid] = call("C_HousingDecor", "GetDecorInstanceInfoForGUID", guid)
    end
    sample.includesDebug = false
    boundedInsert(RoomProbeDB.samples, sample, 50)
    if not quiet then say("Captured sample " .. #RoomProbeDB.samples .. ". Use /roomprobe show to copy it, or /reload to save it to disk.") end
    return sample
end
local function captureWall(label)
    if InCombatLockdown and InCombatLockdown() then say("Wall capture skipped during combat."); return end
    discover()
    local result = call("C_HousingCustomizeMode", "GetSelectedRoomComponentInfo")
    local sample = {time = date("!%Y-%m-%dT%H:%M:%SZ"), label = label ~= "" and label or "wall",
        kind = "room-component", queries = {selectedComponent = result}}
    local info = result.values and result.values["1"]
    if type(info) == "table" then
        sample.component = info
        if type(info.currentThemeSet) == "number" then
            sample.queries.theme = call("C_HousingCustomizeMode", "GetThemeSetInfo", info.currentThemeSet)
        end
        if type(info.type) == "number" then
            sample.queries.wallpapers = call("C_HousingCustomizeMode", "GetWallpapersForRoomComponentType", info.type)
        end
    end
    boundedInsert(RoomProbeDB.samples, sample, 50)
    if type(info) == "table" then
        say("Component captured. Texture record: " .. tostring(info.currentRoomComponentTextureRecID)
            .. "; wallpaper: " .. tostring(info.currentWallpaper) .. ". /reload saves it.")
    else
        say("No readable selected room component (" .. result.status .. "). Select the wall in Customize mode, then /roomprobe wall. Diagnostic saved.")
    end
end
local function quote(value)
    return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
        if c == '"' then return '\\"' end
        if c == '\\' then return '\\\\' end
        return string.format("\\u%04x", string.byte(c))
    end) .. '"'
end
local function json(value, depth)
    depth = depth or 0
    local kind = type(value)
    if kind == "string" then return quote(value) end
    if kind == "boolean" or kind == "number" then return tostring(value) end
    if kind ~= "table" then return "null" end
    local keys, entries = {}, {}
    for key in pairs(value) do keys[#keys + 1] = key end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, key in ipairs(keys) do
        entries[#entries + 1] = string.rep("  ", depth + 1) .. quote(tostring(key)) .. ": " .. json(value[key], depth + 1)
    end
    if #entries == 0 then return "{}" end
    return "{\n" .. table.concat(entries, ",\n") .. "\n" .. string.rep("  ", depth) .. "}"
end
local function show(data)
    if not panel then
        panel = CreateFrame("Frame", "RoomProbeExportFrame", UIParent, "BasicFrameTemplateWithInset")
        panel:SetSize(760, 520)
        panel:SetPoint("CENTER")
        panel:SetMovable(true)
        panel:EnableMouse(true)
        panel:RegisterForDrag("LeftButton")
        panel:SetScript("OnDragStart", panel.StartMoving)
        panel:SetScript("OnDragStop", panel.StopMovingOrSizing)
        panel.TitleText:SetText("RoomProbe - Ctrl+A, Ctrl+C to copy; Escape to close")
        local scroll = CreateFrame("ScrollFrame", nil, panel, "UIPanelScrollFrameTemplate")
        scroll:SetPoint("TOPLEFT", 14, -34)
        scroll:SetPoint("BOTTOMRIGHT", -34, 14)
        editBox = CreateFrame("EditBox", nil, scroll)
        editBox:SetMultiLine(true)
        editBox:SetFontObject(ChatFontNormal)
        editBox:SetWidth(690)
        editBox:SetAutoFocus(false)
        editBox:SetScript("OnEscapePressed", function() panel:Hide() end)
        scroll:SetScrollChild(editBox)
        UISpecialFrames[#UISpecialFrames + 1] = "RoomProbeExportFrame"
    end
    panel:Show()
    editBox:SetText(json(data or RoomProbeDB))
    editBox:SetFocus()
    editBox:HighlightText()
end
RoomProbe = { Copy = safeCopy, JSON = json, Export = show, Say = say, Capture = capture,
    Stop = function() watching = false; blueprintLabel = nil end }
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, event, ...)
    if event == "ADDON_LOADED" then
        if ... ~= addonName then return end
        if type(RoomProbeDB) ~= "table" or RoomProbeDB.schema ~= 1 then
            RoomProbeDB = { schema = 1, samples = {}, events = {} }
        end
        local version, build, buildDate, interface = GetBuildInfo()
        RoomProbeDB.client = { version = version, build = build, buildDate = buildDate, interface = interface }
        RoomProbeDB.addonVersion = "0.4.1"
        RoomProbeDB.blueprints = RoomProbeDB.blueprints or {}
        if RoomProbeRooms then RoomProbeRooms.Initialize() end
        RoomProbeDB.registeredEvents = {}
        for _, name in ipairs(eventNames) do
            local ok = pcall(frame.RegisterEvent, frame, name)
            RoomProbeDB.registeredEvents[name] = ok
        end
        frame:UnregisterEvent("ADDON_LOADED")
        say("Ready. Type /roomprobe to manage saved rooms.")
        return
    end
    if InCombatLockdown and InCombatLockdown() then return end
    if RoomProbeRooms and event == "HOUSING_BLUEPRINT_CONTENTS_RECEIVED" then RoomProbeRooms.Receive(...) end
    if blueprintLabel and (event == "HOUSING_BLUEPRINT_CONTENTS_RECEIVED" or event == "HOUSING_BLUEPRINT_CONTENTS_FAILURE") then
        boundedInsert(RoomProbeDB.blueprints, {
            time = date("!%Y-%m-%dT%H:%M:%SZ"), label = blueprintLabel,
            event = event, args = safeCopy({ ... }),
        }, 20)
        if event == "HOUSING_BLUEPRINT_CONTENTS_RECEIVED" then
            say("Blueprint response captured for " .. blueprintLabel .. ". /roomprobe stop then /reload to save. No import is needed.")
        else
            say("Blueprint request failed; diagnostic response saved. Try reopening its preview.")
        end
    end
    if not watching then return end
    boundedInsert(RoomProbeDB.events, { time = date("!%Y-%m-%dT%H:%M:%SZ"), event = event, args = safeCopy({ ... }) }, 200)
    -- Capture manually after selection settles; event payloads are retained as-is.
end)
SLASH_ROOMPROBE1 = "/roomprobe"
SlashCmdList.ROOMPROBE = function(message)
    local command, label = message:match("^%s*(%S*)%s*(.-)%s*$")
    command = command:lower()
    if command == "" or command == "ui" then if RoomProbeRooms then RoomProbeRooms.Show() end
    elseif command == "wall" then captureWall(label)
    elseif command == "color" then if RoomProbeRooms then RoomProbeRooms.RecordColor() end
    elseif command == "capture" then capture(label ~= "" and label or "manual")
    elseif command == "blueprint" then
        if not RoomProbeDB.registeredEvents.HOUSING_BLUEPRINT_CONTENTS_RECEIVED then
            say("Blueprint contents event is unavailable on this client.")
            return
        end
        blueprintLabel = label ~= "" and label or "blueprint"
        say("Listening for blueprint contents. Close and reopen the blueprint preview, then View List. Do not click Import. Waiting for the game response...")
    elseif command == "debug" then say("Debug probing disabled: WoW restricted these calls to Blizzard UI. Use /roomprobe capture instead.")
    elseif command == "show" then show()
    elseif command == "scan" then discover(); say("Housing API names recorded. Use /roomprobe show to inspect.")
    elseif command == "watch" then watching = true; say("Recording housing events (up to 200). Select items or use the editor normally; /roomprobe stop ends recording.")
    elseif command == "stop" then watching = false; blueprintLabel = nil; say("Event and blueprint recording stopped. /reload writes results to disk.")
    elseif command == "status" then say(#RoomProbeDB.samples .. " samples, " .. #RoomProbeDB.events .. " events, " .. #RoomProbeDB.blueprints .. " blueprint responses. Recording: " .. tostring(watching) .. "; blueprint: " .. (blueprintLabel or "off"))
    else say("Commands: wall [label], color, capture [label], blueprint [label], scan, watch, stop, show, status. /reload saves results.") end
end
