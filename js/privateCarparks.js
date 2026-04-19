// Curated dataset of major private / shopping-mall carparks in Singapore.
//
// Rates are based on publicly-published tariffs as of early 2024. They are
// approximations and may differ from the operator's current schedule - edit
// this file to update.
//
// Tariff model:
//   rate_per_30min       : $/30 min during chargeable window
//   first_free_minutes   : grace period before charging starts (0 if none)
//   per_entry_cap        : max $ charged per single entry (null = no cap)
//   chargeable_start/end : minutes-since-midnight window when rates apply
//                          (0 & 1440 means 24/7 chargeable)
//   weekend_rate_per_30min : optional higher Fri-eve/Sat/Sun rate
//   notes                : shown in UI

window.PRIVATE_CARPARKS = [
  // --- Orchard belt ---
  {
    car_park_no: "ION",
    name: "ION Orchard",
    address: "2 Orchard Turn",
    lat: 1.3042, lng: 103.8320,
    operator: "ION Orchard",
    tariff: {
      rate_per_30min: 1.605,
      weekend_rate_per_30min: 2.14,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "NGEE_ANN",
    name: "Ngee Ann City / Takashimaya",
    address: "391 Orchard Road",
    lat: 1.3039, lng: 103.8345,
    operator: "Ngee Ann",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "PARAGON",
    name: "Paragon",
    address: "290 Orchard Road",
    lat: 1.3047, lng: 103.8363,
    operator: "Paragon",
    tariff: {
      rate_per_30min: 1.712,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "313_SOMERSET",
    name: "313@Somerset",
    address: "313 Orchard Road",
    lat: 1.3009, lng: 103.8384,
    operator: "Lendlease",
    tariff: {
      rate_per_30min: 1.50,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "PLAZA_SING",
    name: "Plaza Singapura",
    address: "68 Orchard Road",
    lat: 1.3006, lng: 103.8452,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },

  // --- Marina Bay / CBD ---
  {
    car_park_no: "MBS",
    name: "Marina Bay Sands",
    address: "10 Bayfront Avenue",
    lat: 1.2838, lng: 103.8590,
    operator: "Marina Bay Sands",
    tariff: {
      rate_per_30min: 5.00,
      first_free_minutes: 0,
      per_entry_cap: 20.00,
      chargeable_start: 0, chargeable_end: 1440,
      notes: "Capped at $20/entry; moving car resets cap"
    }
  },
  {
    car_park_no: "MARINA_SQ",
    name: "Marina Square",
    address: "6 Raffles Boulevard",
    lat: 1.2915, lng: 103.8578,
    operator: "Marina Square",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "SUNTEC",
    name: "Suntec City",
    address: "3 Temasek Boulevard",
    lat: 1.2949, lng: 103.8582,
    operator: "Suntec",
    tariff: {
      rate_per_30min: 1.391,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "RAFFLES_CITY",
    name: "Raffles City",
    address: "252 North Bridge Road",
    lat: 1.2935, lng: 103.8536,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.712,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "FUNAN",
    name: "Funan",
    address: "107 North Bridge Road",
    lat: 1.2911, lng: 103.8499,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "BUGIS_JUNCTION",
    name: "Bugis Junction",
    address: "200 Victoria Street",
    lat: 1.2994, lng: 103.8559,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },

  // --- South / HarbourFront ---
  {
    car_park_no: "VIVOCITY",
    name: "VivoCity",
    address: "1 HarbourFront Walk",
    lat: 1.2643, lng: 103.8218,
    operator: "Mapletree",
    tariff: {
      rate_per_30min: 1.284,
      weekend_rate_per_30min: 1.391,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "HARBOURFRONT_CENTRE",
    name: "HarbourFront Centre",
    address: "1 Maritime Square",
    lat: 1.2656, lng: 103.8217,
    operator: "Mapletree",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },

  // --- Changi / East ---
  {
    car_park_no: "JEWEL",
    name: "Jewel Changi Airport",
    address: "78 Airport Boulevard",
    lat: 1.3601, lng: 103.9893,
    operator: "Jewel",
    tariff: {
      rate_per_30min: 3.18,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440,
      notes: "Higher rates; consider nearby HDB carparks"
    }
  },
  {
    car_park_no: "BEDOK_MALL",
    name: "Bedok Mall",
    address: "311 New Upper Changi Road",
    lat: 1.3247, lng: 103.9301,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "TAMPINES_MALL",
    name: "Tampines Mall",
    address: "4 Tampines Central 5",
    lat: 1.3527, lng: 103.9447,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },

  // --- West ---
  {
    car_park_no: "JURONG_POINT",
    name: "Jurong Point",
    address: "63 Jurong West Central 3",
    lat: 1.3397, lng: 103.7065,
    operator: "Mercatus",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "JEM",
    name: "JEM",
    address: "50 Jurong Gateway Road",
    lat: 1.3334, lng: 103.7427,
    operator: "Lendlease",
    tariff: {
      rate_per_30min: 1.50,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "IMM",
    name: "IMM",
    address: "2 Jurong East Street 21",
    lat: 1.3351, lng: 103.7445,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.00,
      first_free_minutes: 0,
      per_entry_cap: 6.00,
      chargeable_start: 0, chargeable_end: 1440,
      notes: "Capped at $6/entry"
    }
  },

  // --- North / Central HDB town malls ---
  {
    car_park_no: "NEX",
    name: "NEX",
    address: "23 Serangoon Central",
    lat: 1.3507, lng: 103.8722,
    operator: "Mercatus",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "AMK_HUB",
    name: "AMK Hub",
    address: "53 Ang Mo Kio Ave 3",
    lat: 1.3694, lng: 103.8484,
    operator: "Mercatus",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "JUNCTION_8",
    name: "Junction 8",
    address: "9 Bishan Place",
    lat: 1.3504, lng: 103.8487,
    operator: "CapitaLand",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "CAUSEWAY_POINT",
    name: "Causeway Point",
    address: "1 Woodlands Square",
    lat: 1.4363, lng: 103.7863,
    operator: "Frasers",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  },
  {
    car_park_no: "NORTHPOINT",
    name: "Northpoint City",
    address: "930 Yishun Ave 2",
    lat: 1.4290, lng: 103.8354,
    operator: "Frasers",
    tariff: {
      rate_per_30min: 1.284,
      first_free_minutes: 0,
      per_entry_cap: null,
      chargeable_start: 0, chargeable_end: 1440
    }
  }
];
