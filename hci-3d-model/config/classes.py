# config/classes.py

"""
Class ID mappings for the Floor Plan Model Trainer.
These IDs correlate directly with the YOLO model classes and the 
frontend CLASS_COLORS mapping defined in web/index.html.
"""

CLASS_IDS = {
    'Wall': 0,
    'Window': 1,
    'Door': 2,
    'Room': 3,
    'Slab': 4,
    'Roof': 5,
    'Column': 6,
    'Beam': 7,
    'Stair': 8,
    'Railing': 9,
    'CurtainWall': 10,
    'Furniture': 11,
    'Covering': 12,
    'LightFixture': 13,
    'ElectricAppliance': 14,
    'FlowTerminal': 15,
    'EnergyConversionDevice': 16
}

# Automatically generate the reverse lookup dictionary
ID_TO_CLASS = {v: k for k, v in CLASS_IDS.items()}