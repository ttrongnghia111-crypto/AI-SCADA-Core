const express = require('express');
const app = express();
const firebase = require("firebase");

// --- 1. DUY TRÌ NHỊP TIM SERVER ---
app.get('/', (req, res) => res.send('🚀 LÒ PHẢN ỨNG AI SCADA ĐANG CHẠY 24/7!'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Server Cloud đã khởi động!'));

// --- 2. KẾT NỐI DATABASE (Đồng bộ với ESP32 và Web) ---
const firebaseConfig = { 
    databaseURL: "https://khkt-2026-iot-default-rtdb.asia-southeast1.firebasedatabase.app" 
};
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const db = firebase.database();

// TỪ KHÓA BÍ MẬT CỦA GROQ AI
const apiKey = process.env.GROQ_API_KEY; 

let ecoIdeal = { temp_min: 25, temp_max: 28, humi_min: 80, humi_max: 95, air_max: 600 };
let lastEcoData = { t: 0, h: 0, a: 0 };
let ecoErrorConsecutiveMinutes = 0;

console.log("======================================");
console.log("🤖 [AI SUPERVISOR] ĐÃ TIẾN VÀO HỆ THỐNG...");

db.ref("config/eco_ideal").on("value", (snap) => {
    if(snap.exists()) ecoIdeal = Object.assign(ecoIdeal, snap.val());
});

db.ref("sensors").on("value", (snap) => {
    if(snap.exists()) {
        let d = snap.val();
        lastEcoData.t = d.temperature;
        lastEcoData.h = d.humidity;
        lastEcoData.a = d.air_quality || 0;
    }
});

// --- 3. ĐẶC NHIỆM GIÁM SÁT NGẦM (Quét 60s/lần) ---
setInterval(() => {
    if (lastEcoData.t === 0 && lastEcoData.h === 0) return; 
    
    let errorCount = 0;
    if (lastEcoData.t < ecoIdeal.temp_min || lastEcoData.t > ecoIdeal.temp_max) errorCount++;
    if (lastEcoData.h < ecoIdeal.humi_min || lastEcoData.h > ecoIdeal.humi_max) errorCount++;
    if (lastEcoData.a > ecoIdeal.air_max) errorCount++;
    
    if (errorCount > 0) {
        ecoErrorConsecutiveMinutes++;
        console.log(`⚠️ Môi trường trượt ngưỡng ${ecoErrorConsecutiveMinutes} phút!`);
        if (ecoErrorConsecutiveMinutes >= 5) {
            console.log("🚨 [CRITICAL] AI GIẬT QUYỀN ĐIỀU KHIỂN CỨU HỘ...");
            analyzeDataWithAI();
            ecoErrorConsecutiveMinutes = 0; 
        }
    } else {
        ecoErrorConsecutiveMinutes = 0; 
    }
}, 60000); 

// --- 4. HÀM GỌI AI ĐÁM MÂY VÀ ÉP LỆNH XUỐNG ESP32 ---
async function analyzeDataWithAI() {
    // Kỹ thuật ép thư viện fetch chạy trên nền Node.js
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    
    const sys = `Hệ thống SCADA trại nấm. Nhiệt độ: 25-28°C. Độ ẩm: 80-95%. Ngưỡng Quạt: 26-31°C. Ngưỡng Sương: 28-34°C. Trả về JSON: {"new_fan_temp": <float>, "new_mist_temp": <float>, "email_report": "<string>"}`;
    const usr = `T: ${lastEcoData.t}°C. H: ${lastEcoData.h}%. Lập tức xuất JSON.`;

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ 
                model: "llama-3.3-70b-versatile", 
                temperature: 0.0, 
                response_format: { type: "json_object" }, 
                messages: [{ role: "system", content: sys }, { role: "user", content: usr }] 
            })
        });
        
        const data = await response.json();
        if (data.choices) {
            let aiDecision = JSON.parse(data.choices[0].message.content);
            console.log("✨ [AI ĐÃ RA LỆNH]:", aiDecision);
            
            db.ref("controls/fan").update({ auto_en: true, auto_temp: parseFloat(aiDecision.new_fan_temp) });
            db.ref("controls/mist").update({ mode: "auto", auto_temp_en: true, auto_temp_val: parseFloat(aiDecision.new_mist_temp) });
            db.ref("controls/ai_command").update({ trigger: 1, email_report: aiDecision.email_report });
        }
    } catch (e) {
        console.error("❌ LỖI KẾT NỐI AI:", e.message);
    }
}
// ==========================================
// 5. LẮNG NGHE LỆNH THỦ CÔNG TỪ TRÌNH DUYỆT WEB
// ==========================================

// Nghe nút "CHẠY AI PHÂN TÍCH"
db.ref("controls/ai_request").on("value", (snap) => {
    if(snap.exists() && snap.val() > 0) {
        console.log("🔥 Nhận lệnh chạy AI thủ công từ Web!");
        analyzeDataWithAI(); // Gọi lại chính cái hàm AI cứu hộ ở trên
        db.ref("controls/ai_request").set(0); // Reset lệnh
    }
});

// Nghe nút "LƯU THÔNG TIN NẤM"
db.ref("config/mushroom").on("value", async (snap) => {
    if(snap.exists()) {
        let data = snap.val();
        // Nếu thấy có yêu cầu tra cứu mới (chưa xử lý)
        if(data.request_ai && data.request_ai !== data.last_processed) {
            console.log(`🍄 AI Đám mây đang phân tích nấm: ${data.name}`);
            
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            const promptText = `Nấm: "${data.name}". Cung cấp bảng điều kiện tối ưu (Nhiệt độ, Độ ẩm, Khí) cực ngắn gọn bằng HTML.`;
            
            try {
                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.1, messages: [{ role: "user", content: promptText }] })
                });
                const resData = await response.json();
                if (resData.choices) {
                    // Xử lý xong, ném kết quả lại lên Firebase cho Web nó đọc
                    db.ref("config/mushroom").update({ 
                        info: resData.choices[0].message.content,
                        last_processed: data.request_ai // Đánh dấu là đã xử lý xong
                    });
                    console.log(`✅ Đã cập nhật xong thông tin nấm: ${data.name}`);
                }
            } catch (e) { console.error("❌ Lỗi AI tra nấm:", e.message); }
        }
    }
});
