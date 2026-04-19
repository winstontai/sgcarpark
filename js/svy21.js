// SVY21 (Singapore's national projection) <-> WGS84 converter.
// Ported from the public SVY21 reference implementation.
// Singapore's HDB carpark dataset uses SVY21 coordinates (x_coord, y_coord).

(function (global) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const oLat = 1.366666;
  const oLon = 103.833333;
  const oN = 38744.572;
  const oE = 28001.642;
  const k = 1.0;

  const e2 = 2 * f - f * f;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const A0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
  const A2 = (3 / 8) * (e2 + e4 / 4 + 15 * e6 / 128);
  const A4 = (15 / 256) * (e4 + 3 * e6 / 4);
  const A6 = 35 * e6 / 3072;

  const DEG = Math.PI / 180;

  function calcM(latRad) {
    return a * (A0 * latRad
      - A2 * Math.sin(2 * latRad)
      + A4 * Math.sin(4 * latRad)
      - A6 * Math.sin(6 * latRad));
  }

  function svy21ToLatLon(N, E) {
    const Nprime = N - oN;
    const Mo = calcM(oLat * DEG);
    const Mprime = Mo + Nprime / k;

    const n = (a - a * (1 - f)) / (a + a * (1 - f));
    const n2 = n * n, n3 = n2 * n, n4 = n3 * n;
    const G = a * (1 - n) * (1 - n2) * (1 + 9 * n2 / 4 + 225 * n4 / 64) * DEG;
    const sigma = (Mprime * DEG) / G;

    const latPrime = sigma
      + ((3 * n / 2) - (27 * n3 / 32)) * Math.sin(2 * sigma)
      + ((21 * n2 / 16) - (55 * n4 / 32)) * Math.sin(4 * sigma)
      + (151 * n3 / 96) * Math.sin(6 * sigma)
      + (1097 * n4 / 512) * Math.sin(8 * sigma);

    const sinLatP = Math.sin(latPrime);
    const nu = a / Math.sqrt(1 - e2 * sinLatP * sinLatP);
    const rho = a * (1 - e2) / Math.pow(1 - e2 * sinLatP * sinLatP, 1.5);
    const psi = nu / rho;
    const t = Math.tan(latPrime);
    const t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
    const Eprime = E - oE;
    const x = Eprime / (k * nu);
    const x3 = x * x * x, x5 = x3 * x * x, x7 = x5 * x * x;

    const latFactor = t / (k * rho);
    const latTerm1 = latFactor * ((Eprime * x) / 2);
    const latTerm2 = latFactor * ((Eprime * x3) / 24) *
      (-4 * psi * psi + 9 * psi * (1 - t2) + 12 * t2);
    const latTerm3 = latFactor * ((Eprime * x5) / 720) *
      (8 * Math.pow(psi, 4) * (11 - 24 * t2)
        - 12 * Math.pow(psi, 3) * (21 - 71 * t2)
        + 15 * psi * psi * (15 - 98 * t2 + 15 * t4)
        + 180 * psi * (5 * t2 - 3 * t4)
        + 360 * t4);
    const latTerm4 = latFactor * ((Eprime * x7) / 40320) *
      (1385 - 3633 * t2 + 4095 * t4 + 1575 * t6);

    const lat = latPrime - latTerm1 + latTerm2 - latTerm3 + latTerm4;

    const secLatP = 1 / Math.cos(latPrime);
    const lonTerm1 = x * secLatP;
    const lonTerm2 = (x3 * secLatP / 6) * (psi + 2 * t2);
    const lonTerm3 = (x5 * secLatP / 120) *
      (-4 * Math.pow(psi, 3) * (1 - 6 * t2)
        + psi * psi * (9 - 68 * t2)
        + 72 * psi * t2
        + 24 * t4);
    const lonTerm4 = (x7 * secLatP / 5040) *
      (61 + 662 * t2 + 1320 * t4 + 720 * t6);

    const lon = oLon * DEG + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;

    return { lat: lat / DEG, lng: lon / DEG };
  }

  global.SVY21 = { toLatLon: svy21ToLatLon };
})(window);
