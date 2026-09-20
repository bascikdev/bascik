// JS Check 1: Runtime .id assignment
const btn = document.getElementById("demo-btn")!;
btn.id = "new-dynamic-id";

// JS Check 2: Attribute selector in querySelectorAll
const items = document.querySelectorAll("[data-target]");

// JS Check 3: Template-literal class name in classList.replace
const nextState = "active";
btn.classList.replace("old", `state-${nextState}`);

// JS Check 4: Dynamic custom property name in setProperty
btn.style.setProperty("--custom-var", "10px");
