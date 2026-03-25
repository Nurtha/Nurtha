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
