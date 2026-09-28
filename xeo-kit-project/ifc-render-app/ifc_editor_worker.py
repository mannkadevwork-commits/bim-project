import sys
import json
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid

command = sys.argv[1] if len(sys.argv) > 1 else ''

def load_model(path):
    return ifcopenshell.open(path)

def save_model(model, path):
    model.write(path)

def find_by_global_id(model, global_id):
    try:
        return model.by_guid(global_id)
    except Exception:
        for el in model.by_type('IfcProduct'):
            if el.GlobalId == global_id:
                return el
    return None

# ── DEFINE ROOM ───────────────────────────────────────────────────────────────
if command == 'define_room':
    ifc_path  = sys.argv[2]
    room_name = sys.argv[3]
    wall_ids  = json.loads(sys.argv[4])

    model  = load_model(ifc_path)
    storey = model.by_type('IfcBuildingStorey')[0]

    space = ifcopenshell.api.run('root.create_entity', model, ifc_class='IfcSpace', name=room_name)
    ifcopenshell.api.run('aggregate.assign_object', model, relating_object=storey, products=[space])

    walls_linked = 0
    for wid in wall_ids:
        wall = find_by_global_id(model, wid)
        if wall:
            model.create_entity(
                'IfcRelSpaceBoundary',
                GlobalId=ifcopenshell.guid.new(),
                RelatingSpace=space,
                RelatedBuildingElement=wall,
                PhysicalOrVirtualBoundary='PHYSICAL',
                InternalOrExternalBoundary='INTERNAL'
            )
            walls_linked += 1

    save_model(model, ifc_path)
    print(json.dumps({
        'success': True,
        'spaceId': space.GlobalId,
        'roomName': room_name,
        'wallsLinked': walls_linked
    }))

# ── RENAME ELEMENT ────────────────────────────────────────────────────────────
elif command == 'rename_element':
    ifc_path   = sys.argv[2]
    element_id = sys.argv[3]
    new_name   = sys.argv[4]

    model   = load_model(ifc_path)
    element = find_by_global_id(model, element_id)

    if not element:
        print(json.dumps({'success': False, 'error': 'Element not found'}))
        sys.exit(1)

    old_name     = element.Name
    element.Name = new_name
    save_model(model, ifc_path)

    print(json.dumps({
        'success': True,
        'elementId': element_id,
        'oldName': old_name,
        'newName': new_name
    }))

# ── UPDATE SPACE (add/remove walls) ─────────────────────────────────────────
elif command == 'update_space':
    ifc_path  = sys.argv[2]
    space_id  = sys.argv[3]
    wall_ids  = json.loads(sys.argv[4])

    model = load_model(ifc_path)
    space = find_by_global_id(model, space_id)

    if not space:
        print(json.dumps({'success': False, 'error': 'Space not found'}))
        sys.exit(1)

    # Remove all existing IfcRelSpaceBoundary for this space
    to_delete = [
        rel for rel in model.by_type('IfcRelSpaceBoundary')
        if rel.RelatingSpace == space
    ]
    for rel in to_delete:
        model.remove(rel)

    # Re-create boundaries for the new wall list
    walls_linked = 0
    for wid in wall_ids:
        wall = find_by_global_id(model, wid)
        if wall:
            model.create_entity(
                'IfcRelSpaceBoundary',
                GlobalId=ifcopenshell.guid.new(),
                RelatingSpace=space,
                RelatedBuildingElement=wall,
                PhysicalOrVirtualBoundary='PHYSICAL',
                InternalOrExternalBoundary='INTERNAL'
            )
            walls_linked += 1

    save_model(model, ifc_path)
    print(json.dumps({
        'success': True,
        'spaceId': space_id,
        'wallsLinked': walls_linked
    }))

# ── LIST ROOMS ────────────────────────────────────────────────────────────────
elif command == 'list_rooms':
    ifc_path = sys.argv[2]
    model    = load_model(ifc_path)
    rooms    = []

    for space in model.by_type('IfcSpace'):
        wall_ids = []
        for rel in model.by_type('IfcRelSpaceBoundary'):
            if rel.RelatingSpace == space and rel.RelatedBuildingElement:
                wall_ids.append(rel.RelatedBuildingElement.GlobalId)
        rooms.append({
            'id': space.GlobalId,
            'name': space.Name or 'Unnamed Room',
            'wallIds': wall_ids
        })

    print(json.dumps({'success': True, 'rooms': rooms}))

else:
    print(json.dumps({'error': f'Unknown command: {command}'}))
    sys.exit(1)
