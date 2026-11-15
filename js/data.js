/* Static reference data: cities, risk bands and safety guidance.
 * Guidance is paraphrased from India's NDMA heat-wave advisories and the
 * WHO / WMO Global Solar UV Index recommendations. Thresholds for the IMD
 * check come from IMD's published heat-wave criteria.
 */
window.HM = window.HM || {};

/* terrain decides which IMD threshold applies: plains 40°C, coastal 37°C, hilly 30°C */
HM.CITIES = [
  { name: "Delhi", state: "Delhi", lat: 28.6139, lon: 77.2090, terrain: "plains" },
  { name: "Mumbai", state: "Maharashtra", lat: 19.0760, lon: 72.8777, terrain: "coastal" },
  { name: "Kolkata", state: "West Bengal", lat: 22.5726, lon: 88.3639, terrain: "plains" },
  { name: "Chennai", state: "Tamil Nadu", lat: 13.0827, lon: 80.2707, terrain: "coastal" },
  { name: "Bengaluru", state: "Karnataka", lat: 12.9716, lon: 77.5946, terrain: "plains" },
  { name: "Hyderabad", state: "Telangana", lat: 17.3850, lon: 78.4867, terrain: "plains" },
  { name: "Ahmedabad", state: "Gujarat", lat: 23.0225, lon: 72.5714, terrain: "plains" },
  { name: "Pune", state: "Maharashtra", lat: 18.5204, lon: 73.8567, terrain: "plains" },
  { name: "Jaipur", state: "Rajasthan", lat: 26.9124, lon: 75.7873, terrain: "plains" },
  { name: "Lucknow", state: "Uttar Pradesh", lat: 26.8467, lon: 80.9462, terrain: "plains" },
  { name: "Kanpur", state: "Uttar Pradesh", lat: 26.4499, lon: 80.3319, terrain: "plains" },
  { name: "Nagpur", state: "Maharashtra", lat: 21.1458, lon: 79.0882, terrain: "plains" },
  { name: "Indore", state: "Madhya Pradesh", lat: 22.7196, lon: 75.8577, terrain: "plains" },
  { name: "Bhopal", state: "Madhya Pradesh", lat: 23.2599, lon: 77.4126, terrain: "plains" },
  { name: "Patna", state: "Bihar", lat: 25.5941, lon: 85.1376, terrain: "plains" },
  { name: "Surat", state: "Gujarat", lat: 21.1702, lon: 72.8311, terrain: "coastal" },
  { name: "Vadodara", state: "Gujarat", lat: 22.3072, lon: 73.1812, terrain: "plains" },
  { name: "Visakhapatnam", state: "Andhra Pradesh", lat: 17.6868, lon: 83.2185, terrain: "coastal" },
  { name: "Vijayawada", state: "Andhra Pradesh", lat: 16.5062, lon: 80.6480, terrain: "plains" },
  { name: "Ludhiana", state: "Punjab", lat: 30.9010, lon: 75.8573, terrain: "plains" },
  { name: "Amritsar", state: "Punjab", lat: 31.6340, lon: 74.8723, terrain: "plains" },
  { name: "Chandigarh", state: "Chandigarh", lat: 30.7333, lon: 76.7794, terrain: "plains" },
  { name: "Agra", state: "Uttar Pradesh", lat: 27.1767, lon: 78.0081, terrain: "plains" },
  { name: "Varanasi", state: "Uttar Pradesh", lat: 25.3176, lon: 82.9739, terrain: "plains" },
  { name: "Prayagraj", state: "Uttar Pradesh", lat: 25.4358, lon: 81.8463, terrain: "plains" },
  { name: "Jodhpur", state: "Rajasthan", lat: 26.2389, lon: 73.0243, terrain: "plains" },
  { name: "Raipur", state: "Chhattisgarh", lat: 21.2514, lon: 81.6296, terrain: "plains" },
  { name: "Bhubaneswar", state: "Odisha", lat: 20.2961, lon: 85.8245, terrain: "plains" },
  { name: "Guwahati", state: "Assam", lat: 26.1445, lon: 91.7362, terrain: "plains" },
  { name: "Kochi", state: "Kerala", lat: 9.9312, lon: 76.2673, terrain: "coastal" },
  { name: "Thiruvananthapuram", state: "Kerala", lat: 8.5241, lon: 76.9366, terrain: "coastal" },
  { name: "Coimbatore", state: "Tamil Nadu", lat: 11.0168, lon: 76.9558, terrain: "plains" },
  { name: "Madurai", state: "Tamil Nadu", lat: 9.9252, lon: 78.1198, terrain: "plains" },
  { name: "Mangaluru", state: "Karnataka", lat: 12.9141, lon: 74.8560, terrain: "coastal" },
  { name: "Panaji", state: "Goa", lat: 15.4909, lon: 73.8278, terrain: "coastal" },
  { name: "Dehradun", state: "Uttarakhand", lat: 30.3165, lon: 78.0322, terrain: "hilly" },
  { name: "Shimla", state: "Himachal Pradesh", lat: 31.1048, lon: 77.1734, terrain: "hilly" },
  { name: "Srinagar", state: "Jammu & Kashmir", lat: 34.0837, lon: 74.7973, terrain: "hilly" }
];

/* Heat-stress zones, by "feels like" (apparent) temperature in °C.
 * Bands follow the widely used heat-index categories (NOAA / NWS). */
HM.HEAT_LEVELS = [
  {
    id: "comfortable", min: -99, label: "Comfortable", color: "#2f9e5b", ink: "#fff",
    summary: "Little or no heat stress for most people.",
    actions: [
      "Drink water through the day as usual.",
      "A good time for outdoor work and exercise."
    ]
  },
  {
    id: "caution", min: 27, label: "Caution", color: "#e8b100", ink: "#1b1b1b",
    summary: "Tiredness is possible with long exposure and physical activity.",
    actions: [
      "Drink water often, even if you do not feel thirsty.",
      "Wear light-coloured, loose, cotton clothes.",
      "Take short breaks in the shade during outdoor work."
    ]
  },
  {
    id: "extreme-caution", min: 32, label: "Extreme caution", color: "#f07800", ink: "#fff",
    summary: "Heat cramps and heat exhaustion are possible.",
    actions: [
      "Stay out of direct sun between 12 noon and 3 pm where you can.",
      "Carry water. Replace salts with ORS, lassi, buttermilk, lemon water or rice water (torani).",
      "Cover your head with a cap, cloth or umbrella, and wear sunglasses.",
      "Avoid strenuous activity in the afternoon.",
      "Cut down on alcohol, tea, coffee and fizzy sugary drinks; they dehydrate you."
    ]
  },
  {
    id: "danger", min: 41, label: "Danger", color: "#d9282f", ink: "#fff",
    summary: "Heat exhaustion is likely and heatstroke is possible with prolonged exposure.",
    actions: [
      "Stay indoors in the coolest room during the hottest hours.",
      "Move outdoor work to early morning or evening.",
      "Check on elderly people, young children and anyone living alone at least twice a day.",
      "Never leave children or pets in a parked vehicle.",
      "Keep curtains and shades closed by day; open windows at night.",
      "Cool down with baths, damp cloths and fans. Eat light meals, not heavy or stale food."
    ]
  },
  {
    id: "extreme-danger", min: 54, label: "Extreme danger", color: "#7b2cbf", ink: "#fff",
    summary: "Heatstroke is highly likely. Treat the heat as a medical emergency risk.",
    actions: [
      "Do not do any physical work outdoors.",
      "Go to the coolest place you can reach: an air-conditioned building or a public cooling centre.",
      "Watch everyone around you for heatstroke signs and call 108 at once if they appear."
    ]
  }
];

/* WHO / WMO Global Solar UV Index categories */
HM.UV_LEVELS = [
  {
    id: "low", min: 0, label: "Low", color: "#3ea72d", ink: "#fff",
    actions: [
      "Little protection is needed for most people.",
      "Wear sunglasses on bright days."
    ]
  },
  {
    id: "moderate", min: 3, label: "Moderate", color: "#f2d900", ink: "#1b1b1b",
    actions: [
      "Seek shade around midday.",
      "Wear a hat and UV-blocking sunglasses.",
      "Use broad-spectrum sunscreen, SPF 30 or higher, on exposed skin."
    ]
  },
  {
    id: "high", min: 6, label: "High", color: "#f18b00", ink: "#fff",
    actions: [
      "Cut down time in the sun between 10 am and 4 pm.",
      "Cover up with full sleeves, a wide-brimmed hat and sunglasses.",
      "Reapply sunscreen every 2 hours, and after sweating or washing."
    ]
  },
  {
    id: "very-high", min: 8, label: "Very high", color: "#e53210", ink: "#fff",
    actions: [
      "Avoid the sun from late morning to mid-afternoon; unprotected skin can burn quickly.",
      "Stay in shade, cover up fully, and use sunscreen, a hat and sunglasses together.",
      "Keep children out of direct midday sun."
    ]
  },
  {
    id: "extreme", min: 11, label: "Extreme", color: "#8f3f97", ink: "#fff",
    actions: [
      "Stay indoors or in deep shade around midday; skin and eyes can burn within minutes.",
      "If you must go out, take every precaution: clothing, hat, sunglasses and sunscreen."
    ]
  }
];

/* IMD heat-wave thresholds (°C, daily maximum) */
HM.IMD = {
  plains: { threshold: 40, heatwave: 45, severe: 47 },
  coastal: { threshold: 37 },
  hilly: { threshold: 30 }
};

HM.GROUPS = [
  {
    title: "Outdoor workers",
    who: "Construction, delivery, street vendors, traffic police, farm work",
    tips: [
      "Drink a cup of water about every 20 minutes while working, even without thirst.",
      "Do heavy work in the early morning or evening, and rest in shade in between.",
      "Employers should provide shaded rest areas, cool drinking water and ORS.",
      "New workers, or anyone arriving from a cooler place, should build up exposure gradually over about a week."
    ]
  },
  {
    title: "Elderly people, infants and children",
    who: "Bodies that cool down less efficiently",
    tips: [
      "Keep them in the coolest room of the house during the afternoon.",
      "Offer fluids regularly. Babies who are breastfed may need more frequent feeds.",
      "Dress them in light, loose cotton and keep them out of direct sun."
    ]
  },
  {
    title: "Pregnant women",
    who: "Higher risk of dehydration and heat exhaustion",
    tips: [
      "Rest often, avoid exertion in the hot hours and keep water within reach.",
      "See a doctor promptly for dizziness, fainting or reduced fetal movement."
    ]
  },
  {
    title: "People with health conditions",
    who: "Heart disease, high blood pressure, diabetes, kidney or mental-health conditions",
    tips: [
      "Ask your doctor whether your medicines or fluid limits need adjusting during hot weather.",
      "Avoid exertion in the heat and do not stay alone during a heatwave."
    ]
  }
];

HM.HEATSTROKE = {
  signs: [
    "Body temperature of 40°C or higher",
    "Hot, red and dry skin, or heavy sweating",
    "Confusion, slurred speech or unusual behaviour",
    "Throbbing headache, dizziness, nausea or vomiting",
    "Fast, strong pulse; fainting or seizures"
  ],
  firstAid: [
    "Call 108 for an ambulance (or 112 for emergencies).",
    "Move the person to shade or a cool room and loosen tight clothing.",
    "Cool them fast: wet their skin with cool water and fan them; put cold packs on the neck, armpits and groin.",
    "If they are fully awake and can swallow, give small sips of water or ORS. Give nothing by mouth if they are drowsy or unconscious.",
    "Fever medicines do not bring down heatstroke temperature. Cooling does."
  ]
};

HM.SOURCES = [
  { label: "Open-Meteo forecast API (live data)", url: "https://open-meteo.com/" },
  { label: "IMD heat-wave criteria and official warnings", url: "https://mausam.imd.gov.in/" },
  { label: "NDMA heat-wave do's and don'ts", url: "https://ndma.gov.in/Natural-Hazards/Heat-Wave/Dos-Donts" },
  { label: "WHO: UV index", url: "https://www.who.int/news-room/questions-and-answers/item/radiation-the-ultraviolet-(uv)-index" }
];
