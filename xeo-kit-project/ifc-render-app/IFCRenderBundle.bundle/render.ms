-- Find the job folder containing input.obj
dirs = getDirectories "C:\\DARoot\\Jobs\\*"
jobDir = undefined
for d in dirs do
(
    if doesFileExist (d + "input.obj") do jobDir = d
)

if jobDir == undefined do quitMax #noPrompt

objPath = jobDir + "input.obj"
outPath = jobDir + "output.png"
diagPath = jobDir + "diag.txt"
configPath = jobDir + "camera.json"
framesZipPath = jobDir + "frames.zip"

dlog = createFile diagPath
format "Job dir: %\n" jobDir to:dlog
format "OBJ: %\n" objPath to:dlog

try
(
    -- Read camera angle from config
    cameraAngle = "top-front-right"
    if doesFileExist configPath do
    (
        configFile = openFile configPath mode:"r"
        configStr = ""
        while not eof configFile do configStr += readLine configFile + "\n"
        close configFile
        idx = findString configStr "\"angle\""
        if idx != undefined do
        (
            idx2 = findString (substring configStr (idx + 8) -1) "\""
            if idx2 != undefined do
            (
                idx3 = idx + 8 + idx2
                idx4 = findString (substring configStr idx3 -1) "\""
                if idx4 != undefined do
                    cameraAngle = substring configStr idx3 (idx4 - 1)
            )
        )
    )
    format "Camera angle: %\n" cameraAngle to:dlog

    resetMaxFile #noPrompt
    importFile objPath #noPrompt
    format "Objects imported: %\n" objects.count to:dlog

    if objects.count > 0 then
    (
        -- Get scene bounding box
        bMin = [1e9, 1e9, 1e9]
        bMax = [-1e9, -1e9, -1e9]
        for obj in objects do
        (
            if obj.max != undefined and obj.min != undefined do
            (
                if obj.min.x < bMin.x do bMin.x = obj.min.x
                if obj.min.y < bMin.y do bMin.y = obj.min.y
                if obj.min.z < bMin.z do bMin.z = obj.min.z
                if obj.max.x > bMax.x do bMax.x = obj.max.x
                if obj.max.y > bMax.y do bMax.y = obj.max.y
                if obj.max.z > bMax.z do bMax.z = obj.max.z
            )
        )
        center = (bMin + bMax) / 2.0
        sceneSize = length (bMax - bMin)
        camDist = sceneSize * 1.8

        format "Scene center: %\n" center to:dlog
        format "Scene size: %\n" sceneSize to:dlog

        -- MATERIAL
        archMat = standardMaterial()
        archMat.name = "ArchMaterial"
        archMat.diffuse = color 220 215 205
        archMat.specular = color 255 255 255
        archMat.specularLevel = 30
        archMat.glossiness = 25
        archMat.ambient = color 180 175 165
        for obj in objects where superClassOf obj == GeometryClass do
            obj.material = archMat

        -- LIGHTING (shared for all modes)
        keyLight = targetSpot pos:(center + [camDist * -0.5, camDist * -0.8, camDist * 1.2]) target:(targetObject pos:center)
        keyLight.name = "KeyLight"
        keyLight.multiplier = 1.2
        keyLight.color = color 255 245 230
        keyLight.castShadows = true
        keyLight.shadowGenerator = shadowMap()
        keyLight.mapSize = 2048
        keyLight.hotspot = sceneSize * 2
        keyLight.falloff = sceneSize * 3

        fillLight = omniLight pos:(center + [camDist * 0.6, camDist * 0.5, camDist * 0.4])
        fillLight.name = "FillLight"
        fillLight.multiplier = 0.4
        fillLight.color = color 200 210 230
        fillLight.castShadows = false

        sky = Skylight()
        sky.multiplier = 0.6

        backLight = omniLight pos:(center + [camDist * -0.3, camDist * 0.8, camDist * 0.6])
        backLight.name = "BackLight"
        backLight.multiplier = 0.3
        backLight.color = color 220 230 255
        backLight.castShadows = false

        -- RENDERER
        renderers.current = Default_Scanline_Renderer()
        renderers.current.antiAliasFilter = catmull_rom()
        renderWidth = 1920
        renderHeight = 1080

        if cameraAngle == "360" then
        (
            -- 360 MULTI-TIER: 3 elevations x 12 horizontal = 36 frames
            -- Tier 1: Bird's eye (60 deg elevation) - 12 frames
            -- Tier 2: Mid angle (35 deg elevation) - 12 frames  
            -- Tier 3: Eye level (15 deg elevation) - 12 frames
            numHorizontal = 12
            elevations = #(60.0, 35.0, 15.0)
            tierNames = #("high", "mid", "low")
            format "360 mode: % tiers x % horizontal = % frames\n" elevations.count numHorizontal (elevations.count * numHorizontal) to:dlog

            framesDir = jobDir + "frames\\"
            makeDir framesDir

            cam = Targetcamera pos:[0,0,0] target:(targetObject pos:center) fov:45
            cam.name = "RenderCam"
            viewport.setCamera cam

            frameIdx = 0
            for tier = 1 to elevations.count do
            (
                elevAngle = elevations[tier]
                elevRad = degToRad elevAngle
                -- Horizontal radius shrinks as elevation increases
                hRadius = camDist * cos elevRad
                vHeight = camDist * sin elevRad

                format "Tier % (%): elev=% hRadius=% vHeight=%\n" tier tierNames[tier] elevAngle hRadius vHeight to:dlog

                for i = 0 to (numHorizontal - 1) do
                (
                    hAngle = (360.0 / numHorizontal) * i
                    hRad = degToRad hAngle
                    cx = center.x + (hRadius * cos hRad)
                    cy = center.y + (hRadius * sin hRad)
                    cz = center.z + vHeight

                    cam.pos = [cx, cy, cz]
                    framePath = framesDir + "frame_" + (formattedPrint frameIdx format:"03d") + ".png"
                    render camera:cam outputfile:framePath vfb:off backgroundColor:(color 255 255 255)
                    format "Frame %: tier=% h=%deg -> %\n" frameIdx tierNames[tier] hAngle framePath to:dlog
                    frameIdx = frameIdx + 1
                )
            )

            -- Zip all frames
            DOSCommand ("cd /d \"" + framesDir + "\" && tar -cf \"" + framesZipPath + "\" *.png")
            format "Frames zipped: %\n" framesZipPath to:dlog
            format "Zip exists: %\n" (doesFileExist framesZipPath) to:dlog

            -- Preview: mid-tier front view as output.png
            elevRad = degToRad 35.0
            cam.pos = [center.x + (camDist * cos elevRad), center.y, center.z + (camDist * sin elevRad)]
            render camera:cam outputfile:outPath vfb:off backgroundColor:(color 255 255 255)
        )
        else
        (
            -- SINGLE FRAME: Use preset angle
            camOffset = [0.7, -0.7, 0.8]
            case cameraAngle of
            (
                "top-front-right": camOffset = [0.7, -0.7, 0.8]
                "top-front-left":  camOffset = [-0.7, -0.7, 0.8]
                "front":           camOffset = [0.0, -1.2, 0.3]
                "rear":            camOffset = [0.0, 1.2, 0.3]
                "left":            camOffset = [-1.2, 0.0, 0.3]
                "right":           camOffset = [1.2, 0.0, 0.3]
                "birds-eye":       camOffset = [0.3, -0.3, 1.5]
                "top-down":        camOffset = [0.01, -0.01, 1.8]
                "eye-level":       camOffset = [0.8, -0.8, 0.15]
                "isometric":       camOffset = [1.0, -1.0, 1.0]
            )
            format "Camera offset: %\n" camOffset to:dlog

            camPos = center + (camOffset * camDist)
            cam = Targetcamera pos:camPos target:(targetObject pos:center) fov:45
            cam.name = "RenderCam"
            viewport.setCamera cam

            render camera:cam outputfile:outPath vfb:off backgroundColor:(color 255 255 255)
            format "Render saved: %\n" outPath to:dlog
        )

        format "Output exists: %\n" (doesFileExist outPath) to:dlog
    )
    else
    (
        format "No objects imported\n" to:dlog
    )
)
catch
(
    format "EXCEPTION: %\n" (getCurrentException()) to:dlog
)

close dlog
quitMax #noPrompt
