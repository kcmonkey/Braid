$previousBraidAc = $env:BRAID_AC
if ($previousBraidAc) { exit 0 }

try {
  $env:BRAID_AC = '1'

  $status = @(git status --porcelain 2>$null)
  if ($LASTEXITCODE -ne 0 -or $status.Count -eq 0) { exit 0 }

  git add -A 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { exit 0 }

  $files = @(git diff --cached --name-only 2>$null)
  if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { exit 0 }

  $nonDocs = @($files | Where-Object {
    ($_ -notmatch '(^|/)(README|CHANGELOG|AGENTS|CLAUDE)\.md$') -and
    ($_ -notmatch '\.(md|mdx|txt)$')
  })
  $nonTests = @($files | Where-Object {
    $_ -notmatch '(^|/)(test|tests|__tests__)/' -and
    $_ -notmatch '(\.|-)(test|spec)\.[jt]sx?$'
  })

  $type = 'chore'
  if ($nonDocs.Count -eq 0) {
    $type = 'docs'
  } elseif ($nonTests.Count -eq 0) {
    $type = 'test'
  }

  $msg = "${type}: auto-commit workspace changes"
  if ($msg.Length -gt 72) { $msg = $msg.Substring(0, 72) }

  git commit -q -m $msg 2>$null | Out-Null
  exit 0
} catch {
  exit 0
} finally {
  if ($previousBraidAc) {
    $env:BRAID_AC = $previousBraidAc
  } else {
    Remove-Item Env:BRAID_AC -ErrorAction SilentlyContinue
  }
}
