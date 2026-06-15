# config/classes.py

# Complete mapping based on your frontend JS configuration
CLASS_IDS = {
    "Wall": 0,
    "Window": 1,
    "Door": 2,
    "Room": 3,
    "Slab": 4,
    "Roof": 5,
    "Column": 6,
    "Beam": 7,
    "Stair": 8,
    "Railing": 9,
    "CurtainWall": 10,
    "Furniture": 11,
    "Covering": 12,
    "LightFixture": 13,
    "ElectricAppliance": 14,
    "FlowTerminal": 15,
    "EnergyConversionDevice": 16
}

# Reverse mapping for visualization and API responses
ID_TO_CLASS = {v: k for k, v in CLASS_IDS.items()}