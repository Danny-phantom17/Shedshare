"use strict";

require("dotenv").config();
const { productionReadinessErrors, productionReadinessWarnings } = require("../production-readiness");

const errors = productionReadinessErrors(process.env);
const warnings = productionReadinessWarnings(process.env);

if (errors.length) {
  console.error("Production preflight: BLOCKED");
  for (const error of errors) console.error(`- ${error}`);
} else {
  console.log("Production preflight: required environment checks passed.");
}
for (const warning of warnings) console.warn(`Warning: ${warning}`);
if (!errors.length) console.log("This checks configuration shape only; it does not verify provider dashboards, connectivity, buckets, DNS/TLS, or migrations.");
process.exitCode = errors.length ? 1 : 0;
