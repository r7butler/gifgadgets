import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 50 }, // ramp up to 50 VUs
    { duration: "3m", target: 50 }, // hold at 50 VUs
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"], // 95% under 500ms (CloudFront cached)
    http_req_failed: ["rate<0.01"], // less than 1% errors
  },
};

const BASE_URL = __ENV.BASE_URL || "https://gifgadgets.com";

export default function () {
  const res = http.get(`${BASE_URL}/`);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "page contains GifGadgets": (r) => r.body.includes("GifGadgets"),
  });

  sleep(0.5);
}
