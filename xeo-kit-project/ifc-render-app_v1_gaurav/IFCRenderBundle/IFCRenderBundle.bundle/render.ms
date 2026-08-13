-- render.ms
-- IFCRenderBundle_v2 / IFCRenderActivity_v2
--
-- Runs inside Autodesk Design Automation (3dsmaxbatch). Design Automation
-- downloads each Activity parameter into this same working directory before
-- executing this script, so the following are guaranteed to sit right next
-- to this file when it runs:
--   input.obj     (InputFile)    -- merged, Y-up scene from scene_merger.py
--   input.mtl     (MaterialFile) -- OPTIONAL: painted materials (red walls, etc.)
--   camera.json   (CameraConfig) -- { interiorCenter:[x,y,z], interiorSize:[x,y,z], ... }
-- Outputs expected back by aps-pipeline.js:
--   output.png    (OutputFile)
--   diag.txt      (DiagLog)

local workDir    = getFilenamePath (getThisScriptFilename())
local objPath    = workDir + "input.obj"
local camPath    = workDir + "camera.json"
local outPngPath = workDir + "output.png"
local diagPath   = workDir + "diag.txt"

local diagFile = createFile diagPath
fn log msg = ( format "%\n" msg to:diagFile; flush diagFile )

fn extractVec3 jsonText key =
(
    -- No JSON library is guaranteed to be present in the Design Automation
    -- container, and camera.json is always written by our own
    -- aps-pipeline.js with a predictable flat, single-line structure
    -- (JSON.stringify with no pretty-printing), so a small hand-rolled
    -- substring scan is more reliable here than depending on an external
    -- assembly that may not be loaded.
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

try
(
    log "=== IFC 360 Render Pipeline (Arnold Spherical Camera) starting ==="

    -- 1. Start from a clean scene.
    resetMaxFile #noPrompt
    log "Scene reset."

    -- 2. Import the merged OBJ. 3ds Max's native OBJ importer follows the
    --    "mtllib input.mtl" line trimesh wrote into input.obj and will pick
    --    up input.mtl automatically as long as it's in the same folder --
    --    which the MaterialFile parameter's localName guarantees.
    if not (doesFileExist objPath) then throw ("input.obj not found at: " + objPath)
    importFile objPath #noPrompt
    log ("Imported: " + objPath + " (" + (objects.count as string) + " object(s) in scene)")

    local mtlPath = workDir + "input.mtl"
    if (doesFileExist mtlPath) then
        log ("input.mtl present alongside input.obj -- painted materials (e.g. red walls) should be applied.")
    else
        log "No input.mtl found -- scene has no material overrides this render, importer will use default materials."

    -- 3. Read the room's bounding box (already Y-up, already post-merge)
    --    from camera.json, computed once in scene_merger.py so this script
    --    never has to re-derive it from potentially-messy imported geometry.
    if not (doesFileExist camPath) then throw ("camera.json not found at: " + camPath)
    local camJsonText = ""
    local jf = openFile camPath
    while not eof jf do camJsonText += (readLine jf)
    close jf

    local interiorCenter = extractVec3 camJsonText "interiorCenter"
    local interiorSize   = extractVec3 camJsonText "interiorSize"
    log ("interiorCenter: " + (interiorCenter as string))
    log ("interiorSize:   " + (interiorSize as string))

    -- 4. Build the Arnold spherical camera, parked in the middle of the room.
    --    arnold_spherical_camera is MAXtoA's built-in scripted-plugin camera
    --    class (Create panel > Cameras > Arnold > Spherical). It has no
    --    exposed parameters beyond the standard camera transform -- Arnold
    --    renders a full 360x180 equirectangular projection from wherever
    --    it's placed, in whatever direction it's aimed.
    local sphCam = arnold_spherical_camera pos:interiorCenter
    sphCam.name = "IFC_360_Cam"
    -- Left at identity rotation: for a full sphere this only determines
    -- which direction maps to the horizontal center/seam of the
    -- equirectangular image, not what's visible. Rotate sphCam here if you
    -- need a specific wall to land at the center of the output image.
    log ("Placed arnold_spherical_camera '" + sphCam.name + "' at " + (interiorCenter as string))

    -- 5. Make Arnold the active renderer.
    renderers.current = Arnold()
    log "Arnold set as the active production renderer."

    -- 6. Spherical/equirectangular panoramas MUST be rendered at a 2:1
    --    width:height aspect ratio or the projection will be distorted.
    renderWidth = 4096
    renderHeight = 2048
    renderPixelAspect = 1.0
    log ("Render size: " + (renderWidth as string) + "x" + (renderHeight as string) + " (2:1 equirectangular)")

    -- 7. Render straight to output.png (mapped back to OutputFile by the Activity).
    local resultBmp = render camera:sphCam outputfile:outPngPath vfb:false
    if resultBmp != undefined then close resultBmp
    log ("Render complete -> " + outPngPath)

    log "=== SUCCESS ==="
)
catch
(
    log ("=== FAILURE: " + (getCurrentException()) + " ===")
    -- Re-throw isn't necessary: 3dsmaxbatch exit code combined with
    -- OutputFile/required:false in the Activity spec already tells
    -- aps-pipeline.js this workitem failed (no output.png will exist).
)

close diagFile
