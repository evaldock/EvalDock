#!/usr/bin/env node
import { migrateCaseInputs } from "./migrate-case-inputs.mjs";
console.log(JSON.stringify(await migrateCaseInputs("datasets")));
