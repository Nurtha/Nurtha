document.addEventListener("DOMContentLoaded", function () {
    let savedDate = localStorage.getItem("valentineDate");
    if (savedDate) {
        showSavedDate(savedDate);
    }
});

document.getElementById("yesBtn").addEventListener("click", function () {
    document.getElementById("datePicker").classList.remove("hidden");
});

document.getElementById("noBtn").addEventListener("click", function () {
    window.location.href = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // Rickroll
});

document.getElementById("downloadBtn").addEventListener("click", function () {
    let date = document.getElementById("date").value;
    if (date) {
        localStorage.setItem("valentineDate", date);
        showSavedDate(date);

        let text = `Our date: ${date}`;
        let blob = new Blob([text], { type: "text/plain" });
        let link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "Valentine_Date.txt";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } else {
        alert("Please select a date!");
    }
});

document.getElementById("resetBtn").addEventListener("click", function () {
    localStorage.removeItem("valentineDate");
    location.reload();
});

function showSavedDate(date) {
    document.getElementById("selectedDate").textContent = date;
    document.getElementById("datePicker").classList.remove("hidden");
    document.getElementById("resetBtn").classList.remove("hidden");
}
