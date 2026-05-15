#!/usr/bin/env node

/**
 * check-css-usage.js — Find unused CSS class selectors in styles.css.
 *
 * Scans public/styles.css for class selectors, then checks if each class
 * is used anywhere in the codebase. Prints orphan classes to stdout.
 */

const fs = require("fs").promises;
const path = require("path");

// Paths
const STYLES_PATH = path.join(__dirname, "../public/styles.css");
const PUBLIC_DIR = path.join(__dirname, "../public");

// Patterns for class selectors (simplified)
const CLASS_SELECTOR_REGEX = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;

async function getUsedClasses() {
  const usedClasses = new Set();
  
  // Find all .jsx files
  const jsxFiles = await findFiles(PUBLIC_DIR, ".jsx");
  
  for (const file of jsxFiles) {
    try {
      const content = await fs.readFile(file, "utf8");
      
      // Look for className="..." patterns
      const classNameMatches = content.match(/className\s*=\s*["'][^"']*["']/g);
      if (classNameMatches) {
        for (const match of classNameMatches) {
          // Extract class names from className value
          const classes = match.match(/(['"])\s*([^'"]+)\s*\1/);
          if (classes && classes[2]) {
            classes[2].split(/\s+/).forEach(c => usedClasses.add(c.trim()));
          }
        }
      }
      
      // Look for cn() calls
      const cnMatches = content.match(/cn\([^)]+\)/g);
      if (cnMatches) {
        for (const match of cnMatches) {
          // Extract string literals from cn()
          const strings = match.match(/['"][^'"]+['"]/g);
          if (strings) {
            for (const str of strings) {
              str.slice(1, -1).split(/\s+/).forEach(c => usedClasses.add(c.trim()));
            }
          }
        }
      }
    } catch (e) {
      console.error(`Error reading ${file}:`, e.message);
    }
  }
  
  return usedClasses;
}

async function findFiles(dir, ext) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...await findFiles(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  
  return files;
}

async function getStylesheetClasses() {
  try {
    const content = await fs.readFile(STYLES_PATH, "utf8");
    const classes = new Set();
    let match;
    
    while ((match = CLASS_SELECTOR_REGEX.exec(content)) !== null) {
      classes.add(match[1]);
    }
    
    return classes;
  } catch (e) {
    console.error("Error reading styles.css:", e.message);
    return new Set();
  }
}

async function main() {
  console.log("Checking CSS class usage...\n");
  
  const usedClasses = await getUsedClasses();
  const stylesheetClasses = await getStylesheetClasses();
  
  const unusedClasses = [...stylesheetClasses].filter(c => !usedClasses.has(c));
  
  if (unusedClasses.length === 0) {
    console.log("✓ All CSS classes are in use!");
    return;
  }
  
  console.log(`Found ${unusedClasses.length} unused class${unusedClasses.length === 1 ? "" : "es"}:\n`);
  
  for (const className of unusedClasses.sort()) {
    console.log(`  - ${className}`);
  }
  
  console.log("\n" + "=".repeat(50));
  console.log("To remove these classes, use:");
  console.log(`  npx mcp__serena__replace_content --relative_path="public/styles.css" --needle="${unusedClasses.map(c => `\\.${c}`).join("|")}" --repl="" --mode=regex`);
}

main().catch(console.error);
