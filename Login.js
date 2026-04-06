document.getElementById("loginForm").addEventListener("submit", function(e) {
  e.preventDefault();

  const schoolId = document.getElementById("schoolId").value.trim();
  const password = document.getElementById("password").value;
  const errorMsg = document.getElementById("errorMsg");

  // Temporary check (replace with Firebase later)
  if ((schoolId === "yearnerngtaon_2026" && password === "SABYAEMAMLAA") || (schoolId === "Nurtha" && password === "ankenosn")) {
    errorMsg.classList.remove("active");
    alert("Login successful! Redirecting...");
    window.location.href = "Admin.html"; // placeholder redirect
  } else {
    errorMsg.textContent = "Invalid School ID or Password.";
    errorMsg.classList.add("active");
    setTimeout(() => {
      errorMsg.classList.remove("active");
    }, 4000);
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