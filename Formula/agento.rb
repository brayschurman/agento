class Agento < Formula
  desc "Terminal-first repository health checks"
  homepage "https://github.com/your-org/agento"
  url "https://github.com/your-org/agento/releases/download/v0.1.0/agento-0.1.0.tgz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

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
