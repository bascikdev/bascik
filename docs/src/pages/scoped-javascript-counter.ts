const button = document.getElementById("page-counter") as HTMLButtonElement;
let clicks: number = 0;
button.addEventListener("click", () => {
  clicks += 1;
  button.textContent = `Clicked ${clicks} times`;
});
