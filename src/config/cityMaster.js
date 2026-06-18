// Tiny stub city_master. The real CMS resolves City Code from a full master.
// POC: a handful of destinations. If a city is missing, the UI falls back to
// manual entry (see App.jsx lookup band).
const cityMaster = {
  "Kuala Lumpur": "532",
  "Singapore": "319",
  "Bangkok": "311",
  "Bali": "445",
  "Phuket": "401",
  "Dubai": "201",
  "Langkawi": "533",
};

export function lookupCityCode(destinationName) {
  if (!destinationName) return "";
  const key = String(destinationName).trim();
  // exact, then case-insensitive
  if (cityMaster[key] != null) return cityMaster[key];
  const hit = Object.keys(cityMaster).find(
    (k) => k.toLowerCase() === key.toLowerCase()
  );
  return hit ? cityMaster[hit] : "";
}

export default cityMaster;
