// Companion script for <shared-badge>. Attached only if the subfolder rule
// ran for this component's root, so the E2E assertion on its text proves
// getComponentScripts picked the correct (second) root.
const marker = document.getElementById("script-marker");
if (marker) marker.textContent = "companion-script-ran";
