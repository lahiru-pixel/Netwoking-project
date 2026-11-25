param(
    [ValidateSet('all', 'java')]
    [string]$Service = 'all'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

# Prefer the caller's JDK, then PATH, then this machine's installed Java runtime.
if ($env:JAVA_HOME) {
    if (-not (Test-Path "$env:JAVA_HOME/bin/java.exe")) {
        throw 'JAVA_HOME must point to a JDK 21 or newer installation.'
    }
    $env:Path = "$env:JAVA_HOME/bin;" + $env:Path
} elseif (-not (Get-Command java.exe -ErrorAction SilentlyContinue)) {
    $localJava = 'C:/Program Files/JetBrains/PyCharm Community Edition 2025.2.6/jbr'
    if (-not (Test-Path "$localJava/bin/java.exe")) {
        throw 'Install JDK 21 or newer and set JAVA_HOME before starting ExamFlow.'
    }
    $env:JAVA_HOME = $localJava
    $env:Path = "$localJava/bin;" + $env:Path
}

if (-not (Get-Command mvn.cmd -ErrorAction SilentlyContinue)) {
    $mavenBin = Join-Path $projectRoot '.tools/apache-maven-3.9.9/bin'
    if (-not (Test-Path "$mavenBin/mvn.cmd")) {
        throw 'Install Maven 3.9+ and add its bin directory to PATH.'
    }
    $env:Path = "$mavenBin;" + $env:Path
    $mavenRepository = Join-Path $projectRoot '.tools/m2'
    $env:MAVEN_OPTS = "$env:MAVEN_OPTS -Dmaven.repo.local=`"$mavenRepository`""
}
$env:MAVEN_ARGS = "$env:MAVEN_ARGS --batch-mode --no-transfer-progress"

if (-not (Test-Path '.env')) {
    throw 'Create .env from .env.example and configure the two secrets first.'
}
if ($Service -eq 'all') {
    if ((Get-Service MongoDB).Status -ne 'Running') {
        throw 'Start the MongoDB Windows service before launching ExamFlow.'
    }
    & npm.cmd run start:all
} else {
    & npm.cmd run start:java
}
exit $LASTEXITCODE
