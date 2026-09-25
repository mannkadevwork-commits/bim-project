-- render.ms
-- IFCRenderBundle_v2 / IFCRenderActivity_v2
--
-- HCI static 4K renderer for the Autodesk Design Automation worker.
-- Input scene is the already-merged Y-up OBJ produced from the current
-- project_state.json. This script is intentionally presentation-only: all
-- authored scene edits are resolved before the job reaches 3ds Max.
--
-- Required local files (downloaded by Design Automation):
--   input.obj
--   input.mtl (optional)
--   camera.json
-- Outputs: output.png + diag.txt

local workDir    = getFilenamePath (getThisScriptFilename())
local objPath    = workDir + "input.obj"
local camPath    = workDir + "camera.json"
local outPngPath = workDir + "output.png"
local diagPath   = workDir + "diag.txt"

local diagFile = createFile diagPath
fn log msg = ( format "%\n" msg to:diagFile; flush diagFile )

fn readWholeFile filePath =
(
    if not (doesFileExist filePath) then throw ("File not found: " + filePath)
    local f = openFile filePath
    local text = ""
    while not eof f do text += (readLine f)
    close f
    text
)

fn extractVec3 jsonText key =
(
    local marker = "\"" + key + "\":["
    local startIdx = findString jsonText marker
    if startIdx == undefined then throw ("camera.json is missing key: " + key)

    local arrStart = startIdx + marker.count
    local tail = substring jsonText arrStart (jsonText.count - arrStart + 1)
    local relEnd = findString tail "]"
    if relEnd == undefined then throw ("camera.json has an unterminated array for key: " + key)

    local raw = substring tail 1 (relEnd - 1)
    local parts = filterString raw ","
    if parts.count < 3 then throw ("camera.json key '" + key + "' did not parse to 3 components: " + raw)

    [ (parts[1] as float), (parts[2] as float), (parts[3] as float) ]
)

fn extractString jsonText key defaultValue =
(
    local marker = "\"" + key + "\":\""
    local startIdx = findString jsonText marker
    if startIdx == undefined then return defaultValue

    local valueStart = startIdx + marker.count
    local tail = substring jsonText valueStart (jsonText.count - valueStart + 1)
    local endIdx = findString tail "\""
    if endIdx == undefined then defaultValue else substring tail 1 (endIdx - 1)
)

fn extractFloat jsonText key defaultValue =
(
    local marker = "\"" + key + "\":"
    local startIdx = findString jsonText marker
    if startIdx == undefined then return defaultValue

    local valueStart = startIdx + marker.count
    local tail = substring jsonText valueStart (jsonText.count - valueStart + 1)
    local commaIdx = findString tail ","
    local braceIdx = findString tail "}"
    local endIdx = if commaIdx == undefined then braceIdx else if braceIdx == undefined then commaIdx else amin commaIdx braceIdx
    if endIdx == undefined then return defaultValue

    try ((substring tail 1 (endIdx - 1)) as float) catch (defaultValue)
)

fn max3 a b c =
(
    local result = a
    if b > result then result = b
    if c > result then result = c
    result
)

fn pointFromAngle angle center size =
(
    local maxDim = max3 (abs size.x) (abs size.y) (abs size.z)
    if maxDim < 1.0 then maxDim = 1.0
    local dist = maxDim * 1.8
    local low = maxDim * 0.25
    local high = maxDim * 0.85

    case angle of
    (
        "top-front-right": center + [ dist * 0.90, dist * 0.65, dist * 0.90 ]
        "top-front-left":  center + [-dist * 0.90, dist * 0.65, dist * 0.90 ]
        "front":           center + [ 0, low, dist ]
        "rear":            center + [ 0, low, -dist ]
        "left":            center + [-dist, low, 0 ]
        "right":           center + [ dist, low, 0 ]
        "birds-eye":       center + [ dist * 0.20, dist * 1.45, dist * 0.20 ]
        "top-down":        center + [ 0, dist * 1.75, 0.01 ]
        "eye-level":       center + [ 0, high, dist * 1.25 ]
        "isometric":       center + [ dist * 0.85, dist * 0.75, dist * 0.85 ]
        default:            center + [ dist * 0.90, dist * 0.65, dist * 0.90 ]
    )
)

fn addOmni name position rgbColor intensity =
(
    local l = omniLight name:name pos:position
    l.rgb = rgbColor
    l.multiplier = intensity
    try (l.baseObject.castShadows = true) catch()
    l
)

try
(
    log "=== HCI Autodesk 4K Static Render starting ==="
    resetMaxFile #noPrompt
    log "Scene reset."

    if not (doesFileExist objPath) then throw ("input.obj not found at: " + objPath)
    importFile objPath #noPrompt
    log ("Imported OBJ: " + objPath + " | objects=" + (objects.count as string))

    local mtlPath = workDir + "input.mtl"
    if doesFileExist mtlPath then
        log "input.mtl is present; native OBJ materials will be imported."
    else
        log "No input.mtl; rendering imported object materials/defaults."

    local camJsonText = readWholeFile camPath
    local interiorCenter = extractVec3 camJsonText "interiorCenter"
    local interiorSize   = extractVec3 camJsonText "interiorSize"
    local angle          = extractString camJsonText "angle" "top-front-right"
    local lighting       = extractString camJsonText "lighting" "daylight"
    local fov            = extractFloat camJsonText "fov" 45.0

    log ("center=" + (interiorCenter as string))
    log ("size=" + (interiorSize as string))
    log ("angle=" + angle + " | lighting=" + lighting + " | fov=" + (fov as string))

    local camPos = pointFromAngle angle interiorCenter interiorSize
    local target = targetObject pos:interiorCenter
    local cam = targetCamera pos:camPos target:target
    cam.name = "HCI_Static_Cam"
    cam.fov = fov
    log ("Camera position=" + (camPos as string))

    -- Presentation lighting is deliberately created here, after the scene is
    -- imported, so every static render is deterministic and independent from
    -- whatever renderer/lighting state the source OBJ happens to carry.
    -- Standard 3ds Max lights are supported by Arnold translation.
    local key = [235, 225, 205] as color
    local fill = [205, 215, 235] as color
    local rim = [235, 235, 255] as color
    local keyPower = 1.35
    local fillPower = 0.65
    local rimPower = 0.45

    if lighting == "night" then
    (
        key = [185, 200, 235] as color
        fill = [150, 165, 210] as color
        rim = [205, 215, 255] as color
        keyPower = 0.70
        fillPower = 0.35
        rimPower = 0.25
    )

    local maxDim = max3 (abs interiorSize.x) (abs interiorSize.y) (abs interiorSize.z)
    if maxDim < 1.0 then maxDim = 1.0
    addOmni "HCI_Key" (interiorCenter + [-maxDim * 0.65, maxDim * 1.20, maxDim * 0.55]) key keyPower
    addOmni "HCI_Fill" (interiorCenter + [ maxDim * 0.85, maxDim * 0.70, -maxDim * 0.55]) fill fillPower
    addOmni "HCI_Rim" (interiorCenter + [-maxDim * 0.70, maxDim * 0.55, -maxDim * 0.90]) rim rimPower

    renderers.current = Arnold()
    log "Arnold set as current renderer."

    -- Standard 4K UHD output. render() accepts explicit dimensions, so this
    -- does not depend on whatever Render Setup values happen to be persisted
    -- inside the worker image.
    renderWidth = 3840
    renderHeight = 2160
    renderPixelAspect = 1.0

    local resultBmp = render camera:cam outputfile:outPngPath outputsize:[3840,2160] pixelaspect:1.0 vfb:false
    if resultBmp != undefined then close resultBmp
    if not (doesFileExist outPngPath) then throw ("Renderer returned without creating: " + outPngPath)

    log ("Render complete -> " + outPngPath)
    log "=== SUCCESS ==="
)
catch
(
    log ("=== FAILURE: " + (getCurrentException()) + " ===")
)

close diagFile
