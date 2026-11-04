/**
 * Bundled ceiling-mounted catalogue assets shared by the LeftPanel and Ceiling Plan.
 * Keep the item metadata identical so both placement workflows persist the same
 * GLB/light-fixture contract.
 */
export const getCeilingLightingCatalog = () => {
  const baseUrl = new URL(import.meta.env.BASE_URL || '/', window.location.origin);
  const makeItem = (id, name, fileName, description, mountType = 'surface') => ({
    id,
    name,
    description,
    url: new URL(`assets/lighting/${fileName}`, baseUrl).toString(),
    file_type: 'glb',
    fileType: 'glb',
    type: 'lighting',
    category: 'lighting',
    assetCategory: 'lighting',
    isLightFixture: true,
    lightEnabled: false,
    pivotMode: 'top-center',
    placementSurface: 'surface',
    ceilingMountType: mountType,
    scale: [1, 1, 1],
  });

  return [
    makeItem('hci_linear_tubelight', 'Linear LED Tubelight', 'linear-tubelight.glb', 'Ceiling-mounted strip light'),
    makeItem('hci_led_bulb', 'LED Bulb', 'led-bulb.glb', 'Compact LED bulb fixture'),
    makeItem('hci_recessed_downlight', 'Recessed Downlight', 'recessed-downlight.glb', 'Recessed spotlight with automatic ceiling cut-out', 'recessed'),
    makeItem('hci_flush_ceiling', 'Flush-mount Ceiling Light', 'flush-mount-ceiling-light.glb', 'Low-profile ceiling fixture'),
    makeItem('hci_pendant_lamp', 'Pendant Hanging Lamp', 'pendant-lamp.glb', 'Decorative hanging ceiling lamp'),
    makeItem('hci_caged_ceiling', 'Caged Ceiling Light', 'caged-ceiling-light.glb', 'Compact utility ceiling light'),
    makeItem('hci_square_ceiling', 'Square Ceiling Lamp', 'square-ceiling-lamp.glb', 'Compact square ceiling fixture'),
  ];
};
