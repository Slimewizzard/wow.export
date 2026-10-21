RoomProbeRooms = {}
BINDING_HEADER_ROOMPROBE = "RoomProbe"
BINDING_NAME_ROOMPROBE_RECORD_COLOR = "Record selected item's colours"
local R = RoomProbeRooms
local window, selected, page = nil, nil, 1
local recording = false
local status = "Select a room, or start recording and open a blueprint preview."
local function refresh() if window then R.Refresh() end end
local function message(text) status = text; RoomProbe.Say(text); refresh() end
local function trim(text) return (text or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 80) end
local function ordered()
    local list = {}
    for _, room in pairs(RoomProbeDB.rooms) do list[#list+1] = room end
    table.sort(list, function(a,b) if a.name == b.name then return a.id < b.id end return a.name < b.name end)
    return list
end
local function create(name, content, time)
    RoomProbeDB.nextRoomID = (RoomProbeDB.nextRoomID or 0) + 1
    local id = "room-" .. RoomProbeDB.nextRoomID
    while RoomProbeDB.rooms[id] do
        RoomProbeDB.nextRoomID = RoomProbeDB.nextRoomID + 1
        id = "room-" .. RoomProbeDB.nextRoomID
    end
    RoomProbeDB.rooms[id] = {id=id, name=trim(name) ~= "" and trim(name) or "Untitled room", content=RoomProbe.Copy(content), updated=time or date("!%Y-%m-%dT%H:%M:%SZ")}
    return id
end
function R.Initialize()
    RoomProbeDB.rooms = RoomProbeDB.rooms or {}
    selected = RoomProbeDB.selectedRoomID
    if not RoomProbeDB.roomsMigrated then
        local seen = {}
        for _, capture in ipairs(RoomProbeDB.blueprints or {}) do
            local content = capture.args and capture.args["1"]
            if capture.event == "HOUSING_BLUEPRINT_CONTENTS_RECEIVED" and type(content) == "table" and content.contentGroups then
                local key = content.shareCode or RoomProbe.JSON(content)
                if not seen[key] then create(capture.label, content, capture.time); seen[key] = true end
            end
        end
        RoomProbeDB.roomsMigrated = true
    end
    if RoomProbeDB.roomDraft then status = "An unfinished recording is saved. Stop & Save to keep it, or Clear draft." end
end
function R.Start()
    if RoomProbeDB.roomDraft then message("Save or clear the unfinished recording first."); return false end
    recording = true; selected = nil
    message("Recording: close and reopen one blueprint preview, then View List. No import is needed.")
    return true
end
function R.Receive(content)
    if not recording or type(content) ~= "table" then return end
    content = RoomProbe.Copy(content)
    if type(content) ~= "table" or type(content.contentGroups) ~= "table" then return end
    if RoomProbeDB.roomDraft then
        if RoomProbeDB.roomDraft.content.shareCode ~= content.shareCode then
            message("Another blueprint was ignored. Stop & Save this room before recording another.")
        end
        return
    end
    RoomProbeDB.roomDraft = {content=content, time=date("!%Y-%m-%dT%H:%M:%SZ")}
    message("Blueprint captured. Enter a room name, then Stop & Save.")
end
function R.SaveDraft(name)
    recording = false
    local draft = RoomProbeDB.roomDraft
    if not draft then message("Recording stopped; no blueprint was captured."); return false end
    if trim(name) == "" then message("Enter a name before saving."); return false end
    selected = create(name, draft.content, draft.time)
    RoomProbeDB.selectedRoomID = selected
    RoomProbeDB.roomDraft = nil
    message("Room saved. /reload or logout writes SavedVariables to disk.")
    return selected
end
function R.RecordColor()
    local room = selected and RoomProbeDB.rooms[selected]
    if not room then message("Select a saved room in /roomprobe first."); return false end
    local sample = RoomProbe.Capture("room-color", true)
    if not sample then return false end
    local guids = {}
    for _, key in ipairs({"C_HousingDecor.GetSelectedDecorInfo", "C_HousingExpertMode.GetSelectedDecorInfo"}) do
        local query = sample.queries[key]
        local info = query and query.values and query.values["1"]
        if type(info) == "table" and type(info.decorGUID) == "string" then guids[info.decorGUID] = true end
    end
    local found
    for guid in pairs(guids) do
        local query = sample.queries["GetDecorInstanceInfoForGUID:" .. guid]
        local info = query and query.values and query.values["1"]
        if type(info) == "table" and type(info.dyeSlots) == "table" and type(info.decorID) == "number" then
            if found and found.decorGUID ~= guid then message("Selection is ambiguous. Select one item and try again."); return false end
            found = info
        end
    end
    if not found then message("No selected item with readable dye slots. Select an item, then press the shortcut again."); return false end
    local matched = false
    for _, group in pairs(room.content.contentGroups or {}) do
        if tonumber(group.contentType) == 3 then
            for _, entry in pairs(group.entries or {}) do
                if tonumber(entry.recordID) == found.decorID then matched = true end
            end
        end
    end
    if not matched then message("That decor type is not in the selected room inventory."); return false end
    room.dyeCaptures = room.dyeCaptures or {}
    room.dyeCaptures[found.decorGUID] = {decorGUID=found.decorGUID, decorID=found.decorID, name=found.name,
        dyeSlots=RoomProbe.Copy(found.dyeSlots), time=sample.time}
    room.updated = sample.time
    message("Recorded slots for " .. (found.name or tostring(found.decorID)) .. ". Re-recording the same instance updates it. /reload saves to disk.")
    return true
end
function R.Rename(id, name)
    if not RoomProbeDB.rooms[id] or trim(name) == "" then return false end
    RoomProbeDB.rooms[id].name = trim(name)
    message("Room renamed. Existing exported files are unchanged.")
    return true
end
function R.Delete(id)
    RoomProbeDB.rooms[id] = nil
    if selected == id then selected = nil end
    message("Room deleted from saved rooms. Exported assets are unchanged.")
end
function R.ClearDraft()
    recording = false; RoomProbeDB.roomDraft = nil
    message("Draft cleared.")
end
function R.ClearAll()
    RoomProbe.Stop()
    recording = false; selected = nil
    RoomProbeDB.rooms = {}; RoomProbeDB.roomDraft = nil
    RoomProbeDB.samples = {}; RoomProbeDB.events = {}; RoomProbeDB.blueprints = {}
    RoomProbeDB.roomsMigrated = true
    message("All room and diagnostic captures cleared. /reload writes the change to disk.")
end
local function details(content)
    local rows, count = {}, 0
    for _, group in pairs(content.contentGroups or {}) do
        for _, entry in pairs(group.entries or {}) do
            local amount = tonumber(entry.total) or 0
            if tonumber(group.contentType) == 3 then count = count + amount end
            rows[#rows+1] = string.format("%s  x%d%s", entry.name or ("ID " .. tostring(entry.recordID)), amount, tonumber(group.contentType) == 3 and "" or "  (room/fixture)")
        end
    end
    table.sort(rows)
    return count .. " decor pieces\n\n" .. table.concat(rows, "\n")
end
function R.Refresh()
    local list = ordered()
    page = math.max(1, math.min(page, math.max(1, math.ceil(#list/10))))
    for i, button in ipairs(window.rows) do
        local room = list[(page-1)*10+i]
        button.roomID = room and room.id
        button:SetText(room and ((selected == room.id and "> " or "") .. room.name .. " [" .. room.id .. "]") or "")
        button:SetShown(room ~= nil)
    end
    window.pageText:SetText(string.format("%d / %d", page, math.max(1, math.ceil(#list/10))))
    window.TitleText:SetText("RoomProbe — " .. #list .. " saved rooms")
    local room = selected and RoomProbeDB.rooms[selected]
    window.details:SetText(room and details(room.content) or (RoomProbeDB.roomDraft and details(RoomProbeDB.roomDraft.content) or "No room selected."))
    if room then
        local n = 0
        for _ in pairs(room.dyeCaptures or {}) do n = n + 1 end
        window.details:SetText(details(room.content) .. "\n\nCaptured colour instances: " .. n .. "\nShortcut: /roomprobe color or bind Record selected item's colours in Key Bindings.")
    end
    window.detailChild:SetHeight(math.max(226, window.details:GetStringHeight()+8))
    window.status:SetText(status)
    window.start:SetEnabled(not recording and not RoomProbeDB.roomDraft)
    window.save:SetEnabled(recording or RoomProbeDB.roomDraft ~= nil)
    window.rename:SetEnabled(room ~= nil)
    window.delete:SetEnabled(room ~= nil)
    window.export:SetEnabled(room ~= nil)
    if window.color then window.color:SetEnabled(room ~= nil) end
end
function R.Show()
    if not window then
        window = CreateFrame("Frame", "RoomProbeManagerFrame", UIParent, "BasicFrameTemplateWithInset")
        window:SetSize(780, 590); window:SetPoint("CENTER")
        window.TitleText:SetText("RoomProbe — Saved rooms")
        window:SetMovable(true); window:EnableMouse(true); window:RegisterForDrag("LeftButton")
        window:SetScript("OnDragStart", window.StartMoving); window:SetScript("OnDragStop", window.StopMovingOrSizing)
        UISpecialFrames[#UISpecialFrames+1] = "RoomProbeManagerFrame"
        local function button(text,x,y,width,fn)
            local b = CreateFrame("Button",nil,window,"UIPanelButtonTemplate")
            b:SetSize(width,26); b:SetPoint("TOPLEFT",x,y); b:SetText(text); b:SetScript("OnClick",fn); return b
        end
        local function label(text,x,y,width)
            local t=window:CreateFontString(nil,"OVERLAY","GameFontHighlightSmall")
            t:SetPoint("TOPLEFT",x,y); t:SetWidth(width); t:SetJustifyH("LEFT"); t:SetText(text); return t
        end
        label("Saved rooms",16,-40,220)
        window.rows = {}
        for i=1,10 do
            window.rows[i] = button("",16,-62-(i-1)*29,220,function(self)
                selected = self.roomID
                RoomProbeDB.selectedRoomID = selected
                window.name:SetText(RoomProbeDB.rooms[selected].name)
                refresh()
            end)
        end
        button("Previous",16,-359,78,function() page=math.max(1,page-1); refresh() end)
        button("Next",158,-359,78,function() page=page+1; refresh() end)
        window.pageText=label("",102,-368,50)
        label("Room name",254,-40,120)
        window.name = CreateFrame("EditBox",nil,window,"InputBoxTemplate")
        window.name:SetSize(486,26); window.name:SetPoint("TOPLEFT",260,-60)
        window.name:SetAutoFocus(false); window.name:SetMaxLetters(80); window.name:SetText("New room")
        window.name:SetScript("OnEscapePressed",function(self) self:ClearFocus() end)
        window.start=button("Start recording",254,-96,150,function() R.Start() end)
        window.save=button("Stop & Save",413,-96,150,function() R.SaveDraft(window.name:GetText()) end)
        button("Clear draft",572,-96,170,function() R.ClearDraft() end)
        local scroll = CreateFrame("ScrollFrame",nil,window,"UIPanelScrollFrameTemplate")
        scroll:SetPoint("TOPLEFT",254,-136); scroll:SetSize(465,226)
        local child=CreateFrame("Frame",nil,scroll); child:SetSize(460,226); scroll:SetScrollChild(child)
        window.details=child:CreateFontString(nil,"OVERLAY","GameFontHighlight")
        window.details:SetPoint("TOPLEFT"); window.details:SetWidth(455); window.details:SetJustifyH("LEFT")
        window.detailChild = child
        window.rename=button("Rename",254,-376,145,function() R.Rename(selected,window.name:GetText()) end)
        window.export=button("Copy room JSON",410,-376,164,function()
            RoomProbe.Export({schema=1, rooms={[selected]=RoomProbeDB.rooms[selected]}})
        end)
        window.delete=button("Delete room",586,-376,156,function() StaticPopup_Show("ROOMPROBE_DELETE",nil,nil,selected) end)
        window.color=button("Record selected colours",254,-410,230,function() R.RecordColor() end)
        window.status=label("",16,-443,730)
        label("Saved automatically in WoW memory. Use /reload or logout before opening the file in wow.export.\nTypical path: World of Warcraft\\_retail_\\WTF\\Account\\<account>\\SavedVariables\\RoomProbe.lua\nCopy JSON opens selectable text; save the copied text as a .json file outside the game.",16,-467,730)
        button("Clear all saved data",16,-546,190,function() StaticPopup_Show("ROOMPROBE_CLEAR_ALL") end)
        button("Copy all rooms JSON",228,-546,190,function() RoomProbe.Export({schema=1,rooms=RoomProbeDB.rooms}) end)
    end
    window:Show(); refresh()
end
StaticPopupDialogs["ROOMPROBE_DELETE"] = {
    text="Delete this saved room? Exported models and manifests will remain.", button1="Delete", button2="Cancel",
    OnAccept=function(_,id) R.Delete(id) end, timeout=0, whileDead=true, hideOnEscape=true, preferredIndex=3,
}
StaticPopupDialogs["ROOMPROBE_CLEAR_ALL"] = {
    text="Clear all saved rooms, unfinished recordings and diagnostic captures? Exported files will remain.",button1="Clear all",button2="Cancel",
    OnAccept=function() R.ClearAll() end,timeout=0,whileDead=true,hideOnEscape=true,preferredIndex=3,
}
