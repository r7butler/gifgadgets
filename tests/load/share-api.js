import http from "k6/http";
import { check, sleep } from "k6";
import encoding from "k6/encoding";

// Minimal valid GIF (base64)
const MINIMAL_GIF_B64 =
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

export const options = {
  stages: [
    { duration: "30s", target: 10 }, // ramp up to 10 VUs
    { duration: "2m", target: 10 }, // hold at 10 VUs
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<3000"], // 95% of requests under 3s
    http_req_failed: ["rate<0.05"], // less than 5% errors
  },
};

const BASE_URL = __ENV.BASE_URL || "https://gifwidgets.com";

export default function () {
  const payload = JSON.stringify({
    file: MINIMAL_GIF_B64,
    title: `Load test ${Date.now()}`,
    filename: "loadtest.gif",
  });

  const params = {
    headers: { "Content-Type": "application/json" },
  };

  const res = http.post(`${BASE_URL}/api/share`, payload, params);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "has share_url": (r) => {
      try {
        return JSON.parse(r.body).share_url !== undefined;
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}
