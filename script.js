document.getElementById("loginForm").addEventListener("submit", function(e) {
  e.preventDefault();

  const schoolId = document.getElementById("schoolId").value;
  const password = document.getElementById("password").value;

  // Temporary check (replace with Firebase later)
  if (schoolId === "12345" && password === "password") {
    alert("Login successful! Redirecting...");
    window.location.href = "dashboard.html"; // placeholder redirect
  } else {
    document.getElementById("errorMsg").textContent = "Invalid School ID or Password.";
  }
});

/* ===== HOME PAGE LOGIC ===== */

// Category buttons: filter item cards by category
document.querySelectorAll('.category').forEach(cat => {
  cat.addEventListener('click', () => {
    const selected = cat.textContent.toLowerCase();
    document.querySelectorAll('.item-card').forEach(card => {
      const category = card.getAttribute('data-category');
      if (category) {
        const categoryValue = category.toLowerCase();
        card.style.display = categoryValue === selected ? 'block' : 'none';
      }
    });
  });
});

// Search bar functionality: filter item cards by title
const searchBar = document.getElementById('searchBar');
if (searchBar) {
  searchBar.addEventListener('input', () => {
    const query = searchBar.value.toLowerCase();
    document.querySelectorAll('.item-card').forEach(card => {
      const title = card.querySelector('h4').textContent.toLowerCase();
      card.style.display = title.includes(query) ? 'block' : 'none';
    });
  });
}

/* ===== LOGIN PAGE LOGIC ===== */
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", function(e) {
    e.preventDefault();
    const schoolId = document.getElementById("schoolId").value;
    const password = document.getElementById("password").value;

    // Temporary check (replace with Firebase later)
    if (schoolId === "12345" && password === "password") {
      alert("Login successful! Redirecting...");
      window.location.href = "home.html";
    } else {
      document.getElementById("errorMsg").textContent = "Invalid School ID or Password.";
    }
  });
}
