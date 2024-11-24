const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const xlsx = require("xlsx");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");

const url = process.env.URL;
dotenv.config();

const app = express();
app.use(cors({ origin: url, methods: "GET,POST" }));

const upload = multer({ storage: multer.memoryStorage() });

let client;
let isClientInitializing = false;
let qrCodeContent = null; // To store the current QR code

// WebSocket setup
const server = require("http").createServer(app);
const io = new Server(server, {
  cors: { origin: url },
});

// Initialize WhatsApp Client
const initializeWhatsAppClient = async () => {
  if (isClientInitializing) {
    console.log("Client is already initializing...");
    return;
  }

  try {
    isClientInitializing = true;

    if (client) {
      console.log("Destroying existing client...");
      await client.destroy();
      client = null;
    }

    console.log("Initializing new WhatsApp client...");
    client = new Client({ authStrategy: new LocalAuth() });

    client.on("qr", (qr) => {
      console.log("QR Code generated.");
      qrCodeContent = qr; // Save the QR code
      io.emit("qr", qr); // Broadcast QR code to all connected clients
    });

    client.on("ready", () => {
      console.log("WhatsApp client is ready!");
      qrCodeContent = null; // Reset QR code
      io.emit("ready");
    });

    client.on("auth_failure", (msg) => {
      console.error("Authentication failed:", msg);
      qrCodeContent = null;
      io.emit(
        "auth_failure",
        "Authentication failed. Please re-scan the QR code."
      );
    });

    client.on("disconnected", () => {
      console.warn("WhatsApp client disconnected.");
      qrCodeContent = null;
      client = null;
    });

    await client.initialize();
  } catch (error) {
    console.error("Error initializing WhatsApp client:", error);
    isClientInitializing = false;
    client = null;
  }
};

// Utility function to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parse Excel file and extract phone numbers
const parseExcelFile = (buffer) => {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 }); // Convert the sheet to JSON

  console.log("Raw data from Excel:", data); // Log the extracted data for debugging

  // Extract numbers from the "MobileNumber" column
  const mobileNumbers = data
    .slice(1) // Skip the header row
    .map((row) => row[0]) // Access the first column of each row
    .filter((num) => num !== undefined) // Ensure the value is not undefined
    .map((num) => (typeof num === "number" ? num.toString() : num)) // Convert numbers to strings
    .filter((num) => /^[0-9]+$/.test(num.trim())) // Ensure it's numeric
    .map((num) => num.trim());

  console.log("Extracted mobile numbers:", mobileNumbers);
  return mobileNumbers;
};

// API Endpoint to send messages with a 15-second delay
app.post("/send-messages", upload.single("file"), async (req, res) => {
  const { message } = req.body;

  if (!req.file || !message) {
    return res.status(400).json({ error: "File and message are required." });
  }

  try {
    const mobileNumbers = parseExcelFile(req.file.buffer);

    if (!mobileNumbers.length) {
      return res.status(400).json({ error: "No valid mobile numbers found." });
    }

    if (!client || !client.info) {
      return res
        .status(500)
        .json({ error: "WhatsApp client is not initialized or ready." });
    }

    console.log(`Sending messages to ${mobileNumbers.length} numbers...`);

    // Send messages with a 15-second delay
    for (const [index, number] of mobileNumbers.entries()) {
      console.log(
        `Sending message to ${number} (${index + 1}/${mobileNumbers.length})...`
      );

      // Send the message
      await client.sendMessage(`${number}@c.us`, message);
      console.log(`Message sent to ${number}`);

      // Add a delay of 15 seconds, except after the last message
      if (index < mobileNumbers.length - 1) {
        console.log(
          "Waiting for 15 seconds before sending the next message..."
        );
        await delay(15000); // 15 seconds delay
      }
    }

    res.status(200).json({ message: "Messages sent successfully!" });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to send messages." });
  }
});

// API Endpoint to link device
app.get("/link-device", async (req, res) => {
  if (qrCodeContent) {
    // If QR code already exists, resend it
    io.emit("qr", qrCodeContent);
    return res
      .status(200)
      .json({ message: "QR code already generated. Scan to link the device." });
  }

  console.log("Initializing client for QR code generation...");
  await initializeWhatsAppClient();
  res
    .status(200)
    .json({ message: "Device linking initiated. QR code will be generated." });
});

// Start server
server.listen(process.env.PORT, () => {
  console.log("Server running on port 4001");
});

// Initialize client on server start
initializeWhatsAppClient();
