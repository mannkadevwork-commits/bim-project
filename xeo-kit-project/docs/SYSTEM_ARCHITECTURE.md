# System Architecture

This document explains how the frontend and backend communicate.

---

# High Level Flow

```
            User

              │

              ▼

      BIM Viewer (Frontend)

              │

              ▼

      Backend REST APIs

              │

              ▼

      IFC Processing Pipeline

              │

              ▼

 Updated IFC / GLB / Navigation
```

---

# Complete Flow

## Step 1

User uploads or opens an IFC project.

Frontend loads the IFC using Xeokit.

---

## Step 2

User edits the project.

Examples

- Add Door
- Delete Door
- Add Furniture
- Move Furniture
- Wall Editing

These edits are NOT written directly into the IFC.

Instead the frontend stores them inside

```
project_state.json
```

This JSON represents all user modifications.

---

## Step 3

Whenever rendering/export is requested,

Frontend sends

```
input.ifc

+

project_state.json
```

to the backend.

---

## Step 4

Backend reads

```
input.ifc

+

project_state.json
```

The Python rendering pipeline merges both.

Result

```
Updated Scene
```

---

## Step 5

Backend generates

```
output.glb
```

This GLB contains

- IFC Geometry
- Furniture
- Doors
- Wall modifications
- Materials

---

## Step 6

Backend also generates

```
navigation.json
```

This contains

- Viewpoints
- Navigation links
- Walkthrough graph

---

## Step 7

Backend generates

```
360_viewer.html
```

This viewer loads

```
output.glb

+

navigation.json
```

to provide the interactive walkthrough.

---

# File Flow

```
input.ifc

        +

project_state.json

        │

        ▼

Backend Merge

        │

        ▼

output.glb

        +

navigation.json

        +

360_viewer.html
```

---

# Where are user edits stored?

User edits are stored inside

```
project_state.json
```

Examples

- Furniture
- Doors
- Wall edits
- Material changes

The original IFC remains unchanged.

---

# Where is the GLB generated?

The backend creates

```
output.glb
```

inside the current job directory.

Each job has its own generated assets.

Example

```
jobs/

job_xxxxx/

input.ifc

project_state.json

output.glb

navigation.json

360_viewer.html
```

---

# Important Note

The backend never modifies the original IFC directly.

Instead

```
Original IFC

+

Project State

↓

Merged Scene

↓

GLB
```

This keeps the workflow non-destructive.