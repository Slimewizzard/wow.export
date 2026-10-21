import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.test-deps'))
from lupa.lua51 import LuaRuntime

lua = LuaRuntime(unpack_returned_tuples=True)
lua.execute(r'''
frames = {}
SlashCmdList, UISpecialFrames = {}, {}
UIParent, ChatFontNormal = {}, {}
combat = false
function InCombatLockdown() return combat end
function print(...) end
function date(...) return '2026-09-14T12:00:00Z' end
function GetBuildInfo() return '12.1.0', '69814', 'test', 120100 end
secretToken = {}
function issecretvalue(v) return rawequal(v, secretToken) end
function CreateFrame(kind, name)
    local f = { scripts = {}, events = {}, TitleText = {SetText = function() end} }
    function f:RegisterEvent(event)
        if event == 'HOUSING_LAYOUT_ROOM_SELECTED' then error('unknown event') end
        self.events[event] = true
    end
    function f:UnregisterEvent(event) self.events[event] = nil end
    function f:SetScript(event, fn) self.scripts[event] = fn end
    function f:SetText(value) self.text = value end
    setmetatable(f, {__index = function() return function() end end})
    frames[#frames + 1] = f
    return f
end
C_HousingDecor = {
 GetSelectedDecorInfo = function()
   local t = {decorGUID = 'Housing-test', name = 'Couch "test"\nline',
      probeSecret = secretToken, position = {x = 1, y = 2, z = 3}}
   t.cycle = t
   return t
 end,
 GetHoveredDecorInfo = function() return nil end,
 GetNumDecorPlaced = function() return 28 end,
 GetDecorInstanceInfoForGUID = function(guid) return {decorGUID = guid, decorID = 123} end,
 GetAllPlacedDecor = function() error('RESTRICTED FUNCTION MUST NOT RUN') end,
}
C_HousingExpertMode = {GetSelectedDecorInfo = function() error('test failure') end}
debugCalls = 0
C_HousingDecor.GetSelectedDecorDebugInfo = function()
  debugCalls = debugCalls + 1
  return {testPosition = {x=12, y=34, z=56}}
end
C_HousingDecor.GetDecorDebugInfoForGUID = function(guid) return {testGUID=guid} end
function dispatch(event, ...) frames[1].scripts.OnEvent(frames[1], event, ...) end
''')
lua.execute('assert(loadstring(...))("RoomProbe")', (ROOT / 'addons/wow/RoomProbe/RoomProbe.lua').read_text())
lua.execute('''
dispatch('ADDON_LOADED', 'OtherAddon')
assert(RoomProbeDB == nil)
dispatch('ADDON_LOADED', 'RoomProbe')
assert(RoomProbeDB.client.interface == 120100)
assert(RoomProbeDB.registeredEvents.HOUSING_LAYOUT_ROOM_SELECTED == false)
SlashCmdList.ROOMPROBE('capture couch')
assert(#RoomProbeDB.samples == 1)
local q = RoomProbeDB.samples[1].queries
assert(q['C_HousingDecor.GetSelectedDecorInfo'].values['1'].position.x == 1)
assert(q['C_HousingDecor.GetSelectedDecorInfo'].values['1'].probeSecret == '<secret value omitted>')
assert(q['C_HousingDecor.GetSelectedDecorInfo'].values['1'].cycle == '<cycle>')
assert(q['C_HousingDecor.GetHoveredDecorInfo'].values['1'] == '<nil>')
assert(q['C_HousingExpertMode.GetSelectedDecorInfo'].status == 'error')
assert(q['C_HouseEditor.GetActiveHouseEditorMode'].status == 'unavailable')
assert(q['GetDecorInstanceInfoForGUID:Housing-test'].values['1'].decorID == 123)
dispatch('HOUSING_DECOR_SELECTED', 'Housing-test')
assert(#RoomProbeDB.events == 0)
SlashCmdList.ROOMPROBE('watch')
for i = 1, 205 do dispatch('HOUSING_DECOR_SELECTED', i) end
assert(#RoomProbeDB.events == 200)
SlashCmdList.ROOMPROBE('stop')
dispatch('HOUSING_DECOR_SELECTED', 'ignored')
assert(#RoomProbeDB.events == 200)
combat = true
SlashCmdList.ROOMPROBE('capture skipped')
assert(#RoomProbeDB.samples == 1)
combat = false
for i = 1, 55 do SlashCmdList.ROOMPROBE('capture item' .. i) end
assert(#RoomProbeDB.samples == 50)
assert(debugCalls == 0)
SlashCmdList.ROOMPROBE('show')
''')
report = json.loads(lua.eval('frames[#frames].text'))
assert report['samples']['50']['label'] == 'item55'
assert len(report['events']) == 200
assert report['samples']['50']['queries']['C_HousingDecor.GetSelectedDecorInfo']['values']['1']['name'] == 'Couch "test"\nline'
assert 'GetAllPlacedDecor' in report['api']['C_HousingDecor'].values()
lua.execute('''
SlashCmdList.ROOMPROBE('debug debug-test')
assert(debugCalls == 0)
local sample = RoomProbeDB.samples[50]
assert(sample.includesDebug == false)
assert(sample.label == 'item55')
assert(sample.queries['C_HousingDecor.GetSelectedDecorDebugInfo'] == nil)
assert(sample.queries['GetDecorDebugInfoForGUID:Housing-test'] == nil)
assert(#RoomProbeDB.blueprints == 0)
dispatch('HOUSING_BLUEPRINT_CONTENTS_RECEIVED', {shareCode='not-recorded'})
assert(#RoomProbeDB.blueprints == 0)
SlashCmdList.ROOMPROBE('blueprint living room')
local payload = {shareCode='test', contentGroups={
 {contentType=3, entries={{recordID=1738, name='Wide Charming Couch', total=2, numMissing=2}}},
 {contentType=2, entries={{recordID=42, name='Octagon Room', total=1}}}
}}
dispatch('HOUSING_BLUEPRINT_CONTENTS_RECEIVED', payload)
assert(#RoomProbeDB.blueprints == 1)
local bp = RoomProbeDB.blueprints[1]
assert(bp.label == 'living room')
assert(bp.args['1'].contentGroups['1'].entries['1'].total == 2)
assert(bp.args['1'].contentGroups['1'].entries['1'].numMissing == 2)
assert(bp.args['1'].contentGroups['2'].entries['1'].name == 'Octagon Room')
assert(#RoomProbeDB.events == 200)
for i=1,25 do dispatch('HOUSING_BLUEPRINT_CONTENTS_RECEIVED', payload) end
assert(#RoomProbeDB.blueprints == 20)
SlashCmdList.ROOMPROBE('stop')
dispatch('HOUSING_BLUEPRINT_CONTENTS_RECEIVED', {shareCode='ignored'})
assert(RoomProbeDB.blueprints[20].args['1'].shareCode == 'test')
''')
print('PASS: Lua 5.1 load, initialization, getter results, missing/error APIs, secret/cycle handling, event opt-in, combat guard, retention limits, JSON round-trip.')

