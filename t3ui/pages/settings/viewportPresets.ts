// The browser's device presets, copied from packages/shared/src/previewViewport.ts (Chromium
// EmulatedDevices sizes, in the order of PREVIEW_VIEWPORT_PRESET_IDS in contracts preview.ts).
export interface ViewportPreset { id: string; label: string; detail: string; width: number; height: number }

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: "iphone-se", label: "iPhone SE", detail: "375 × 667", width: 375, height: 667 },
  { id: "iphone-xr", label: "iPhone XR", detail: "414 × 896", width: 414, height: 896 },
  { id: "iphone-12-pro", label: "iPhone 12 Pro", detail: "390 × 844", width: 390, height: 844 },
  { id: "iphone-14-pro-max", label: "iPhone 14 Pro Max", detail: "430 × 932", width: 430, height: 932 },
  { id: "pixel-7", label: "Pixel 7", detail: "412 × 915", width: 412, height: 915 },
  { id: "samsung-galaxy-s8-plus", label: "Samsung Galaxy S8+", detail: "360 × 740", width: 360, height: 740 },
  { id: "samsung-galaxy-s20-ultra", label: "Samsung Galaxy S20 Ultra", detail: "412 × 915", width: 412, height: 915 },
  { id: "ipad-mini", label: "iPad Mini", detail: "768 × 1024", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", detail: "820 × 1180", width: 820, height: 1180 },
  { id: "ipad-pro", label: "iPad Pro", detail: "1024 × 1366", width: 1024, height: 1366 },
  { id: "surface-pro-7", label: "Surface Pro 7", detail: "912 × 1368", width: 912, height: 1368 },
  { id: "surface-duo", label: "Surface Duo", detail: "540 × 720", width: 540, height: 720 },
  { id: "galaxy-z-fold-5", label: "Galaxy Z Fold 5", detail: "344 × 882", width: 344, height: 882 },
  { id: "asus-zenbook-fold", label: "Asus Zenbook Fold", detail: "853 × 1280", width: 853, height: 1280 },
  { id: "samsung-galaxy-a51-71", label: "Samsung Galaxy A51/71", detail: "412 × 914", width: 412, height: 914 },
  { id: "nest-hub", label: "Nest Hub", detail: "1024 × 600", width: 1024, height: 600 },
  { id: "nest-hub-max", label: "Nest Hub Max", detail: "1280 × 800", width: 1280, height: 800 },
]
