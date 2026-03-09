import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [tarballPath, tarballUrl] = process.argv.slice(2);

if (!tarballPath || !tarballUrl) {
  console.error('Usage: pnpm formula <tarball-path> <tarball-url>');
  process.exit(1);
}

const packageJsonPath = path.resolve('package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const tarballBuffer = await readFile(path.resolve(tarballPath));
const sha256 = createHash('sha256').update(tarballBuffer).digest('hex');

const formula = `class Agento < Formula
  desc "${packageJson.description}"
  homepage "https://github.com/your-org/agento"
  url "${tarballUrl}"
  sha256 "${sha256}"
  license "${packageJson.license}"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/agento"
  end

  test do
    output = shell_output("#{bin}/agento")
    assert_match "agento v0.1", output
  end
end
`;

await writeFile(path.resolve('Formula/agento.rb'), formula, 'utf8');
console.log('Wrote Formula/agento.rb');
