// Test double for Docker CLI: fail dependency installation with a secret-shaped diagnostic.
const args = process.argv.slice(2);
if (args.includes("install")) {
  process.stderr.write("npm ERR! api_key=private-build-key package could not be installed\n");
  process.exit(1);
}
process.exit(0);
