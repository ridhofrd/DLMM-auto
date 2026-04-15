/**
 * Test script for GMGN API integration.
 */
import "dotenv/config";
import { getGMGNTokenAnalysis } from "../tools/gmgn.js";

async function main() {
  const mint = process.argv[2] || "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

  console.log(`Testing GMGN API for token: ${mint}...`);
  try {
    const analysis = await getGMGNTokenAnalysis(mint);
    console.log("GMGN Analysis Result:");
    console.log(JSON.stringify(analysis, null, 2));

    if (analysis.security || analysis.stats || (analysis.klines && analysis.klines.length > 0)) {
      console.log("\n✅ GMGN API integration works!");
    } else {
      console.log("\n❌ GMGN API returned no data. This is likely due to Cloudflare blocking this AI agent's IP.");
      console.log("Please run this script on your local machine to verify, as your residential IP should pass.");
    }
  } catch (error) {
    console.error("\n❌ GMGN API test failed:");
    console.error(error.message);
  }
}

main();
