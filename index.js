require("dotenv").config(); // Load environment variables from .env file

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose"); // Import Mongoose
const http = require('http'); // Import http module for making requests

// --- IMPORTANT: Configure these ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Get this from @BotFather
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Your personal Telegram Chat ID
const CHANNEL_ID = process.env.CHANNEL_ID; // Your "Matu Channel" ID (e.g., -1001234567890)
const MONGODB_URI = process.env.MONGODB_URI; // MongoDB connection string

// The URL of your deployed application. This is used by the bot itself
// to send periodic requests to its own server endpoint to keep it awake
// on hosting platforms like Render.
// You MUST set this in your .env file to your actual deployed URL (e.g., https://your-app-name.onrender.com).
// If running locally for testing, you can use 'http://localhost:3000'.
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

if (!TOKEN || !ADMIN_CHAT_ID || !CHANNEL_ID || !MONGODB_URI) {
  console.error(
    "Error: Please set TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, CHANNEL_ID, and MONGODB_URI in your .env file."
  );
  process.exit(1); // Exit if essential environment variables are missing
}

// --- MongoDB Connection ---
mongoose
  .connect(MONGODB_URI)
  .then(() => {}) // Removed console.log
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1); // Exit if DB connection fails
  });

// --- Define Mongoose Schema and Model for Members ---
const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // Telegram User ID
  expiryTimestamp: { type: Number, required: true }, // Unix timestamp (seconds)
  status: {
    type: String,
    enum: ["active", "expired", "banned"],
    default: "active",
  },
  joinedAt: { type: Date, default: Date.now },
});

const Member = mongoose.model("Member", memberSchema);

// --- Initialize Telegram Bot ---
const bot = new TelegramBot(TOKEN, { polling: true });

// --- Utility function to escape Markdown (legacy) special characters ---
function escapeMarkdown(text) {
  // Escape characters for Markdown (legacy) parsing mode
  // Characters to escape: _ * ` [ ] ( ) ~ > # + - = | { } . !
  // Note: Only common ones are explicitly listed, adjust as needed.
  return text.replace(/([_*`\[\]()~>#+\-=|{}.!])/g, "\\$1");
}

// --- Start Command ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `Welcome to the Matu Channel! Get access to exclusive, up-to-date worksheets that are almost identical to real exam questions.
      
    This channel includes
      - past exams 2017, 2016, 2015 ... 
      - currently focus on mathematics only
      - guaranted A-, A, and A+ -> we will return your money if you didn't get one,
      - class room lecture videos
      - 10/7 access to teachers and mentors 
      - live exams
      - and more 

    To join, its 200birr per month.
    
    Once you've paid, send a screenshot of your payment confirmation (the transaction slip) directly to this chat. We'll review it manually and grant you immediate access.`
  );
});

// --- Help Command ---
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `To get access:
1. Make your payment.
2. Send a clear screenshot of your payment confirmation (transaction slip) to this chat.
3. An admin will review it and grant you access.
`
  );
});

// --- Handle Photos (Payment Screenshots) ---
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id; // User's chat ID
  const userId = msg.from.id; // User's Telegram ID
  const username = msg.from.username
    ? `@${msg.from.username}`
    : msg.from.first_name;

  // Get the largest photo (Telegram sends multiple sizes)
  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;

  // Notify user that screenshot is being reviewed
  await bot.sendMessage(
    chatId,
    `Thank you for sending your payment screenshot! We have received it and an admin will review it shortly. Please await our confirmation.`
  );

  // Define inline keyboard for admin approval/decline
  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `approve_user ${userId}` }, // Callback data for approve action
        { text: "❌ Decline", callback_data: `decline_user ${userId}` }, // Callback data for decline action
      ],
    ],
  };

  // Forward the photo to the admin with inline keyboard
  try {
    await bot.sendPhoto(ADMIN_CHAT_ID, fileId, {
      caption: `New payment screenshot from ${username} (ID: ${userId}).
Please verify payment and click a button below.
Original message ID: ${msg.message_id} in chat ${chatId}`,
      reply_markup: inlineKeyboard, // Attach the inline keyboard
    });
  } catch (error) {
    console.error(`Failed to forward photo to admin:`, error.message);
    bot.sendMessage(
      chatId,
      `Apologies, but there was an issue forwarding your screenshot to the admin. Please try again or contact support directly.`
    );
  }
});

// --- Reusable Approval Logic ---
async function handleApproval(
  targetUserId,
  adminChatId,
  messageIdToEdit = null
) {
  try {
    // Check if the user already exists and is active BEFORE generating a new link
    const existingMember = await Member.findOne({
      userId: String(targetUserId),
      status: "active", // Only consider active memberships
    });

    if (existingMember) {
      // If a member exists and is active, notify the admin and the user (if possible)
      const expiryDate = new Date(existingMember.expiryTimestamp * 1000); // Convert back to milliseconds
      const escapedExpiryDate = escapeMarkdown(expiryDate.toLocaleDateString());

      const notificationMessage = `User ${targetUserId} already has an active subscription expiring on ${escapedExpiryDate}. No new invite link generated.`;

      if (messageIdToEdit && adminChatId) {
        try {
          await bot.editMessageCaption(
            notificationMessage + "\n\n*STATUS: ALREADY ACTIVE*",
            {
              chat_id: adminChatId,
              message_id: messageIdToEdit,
              parse_mode: "Markdown",
            }
          );
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: adminChatId, message_id: messageIdToEdit }
          );
        } catch (editError) {
          if (
            editError.message &&
            editError.message.includes(
              "specific new message content and reply markup are exactly the same"
            )
          ) {
            // Ignore redundant edit
          } else {
            console.error(
              `Error editing admin message for existing active user ${targetUserId}:`,
              editError.message
            );
          }
        }
      } else {
        await bot.sendMessage(adminChatId, notificationMessage);
      }

      // Optionally, try to inform the user if they can receive messages from the bot
      try {
        await bot.sendMessage(
          targetUserId,
          `It seems your subscription to the Matu Channel is still active and expires on *${escapedExpiryDate}*. If you believe this is an error, please contact support: +251908302638`,
          { parse_mode: "Markdown" }
        );
      } catch (userNotifyError) {
        // User may have blocked bot
      }
      return; // Exit the function as the user is already active
    }

    const inviteLink = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600, // Link expires in 1 hour
      creates_join_request: false,
      name: `Access for user ${targetUserId}`,
    });

    // --- MongoDB: Calculate and Store Expiry Date ---
    const now = new Date();
    const expiryDate = new Date(now.setMonth(now.getMonth() + 1));
    const expiryTimestamp = Math.floor(expiryDate.getTime() / 1000);
    const escapedExpiryDate = escapeMarkdown(expiryDate.toLocaleDateString());

    await Member.findOneAndUpdate(
      { userId: String(targetUserId) },
      { expiryTimestamp, status: "active", joinedAt: new Date() },
      { upsert: true, new: true }
    );

    // Send the invite link to the approved user
    await bot.sendMessage(
      targetUserId,
      `Your payment has been verified! You can now join the Matu Channel using this one-time link:
${inviteLink.invite_link}
Your access will expire on *${escapedExpiryDate}*. Thank you for choosing us!`,
      { parse_mode: "Markdown" }
    );

    // Confirm to admin (and optionally edit the message if it came from a button)
    const confirmationMessage = `Invite link for user ${targetUserId} generated and sent: ${inviteLink.invite_link}\nAccess expires on: ${escapedExpiryDate}`;

    if (messageIdToEdit && adminChatId) {
      try {
        // Edit the photo caption to indicate approval
        await bot.editMessageCaption(
          confirmationMessage + "\n\n*STATUS: APPROVED ✅*",
          {
            chat_id: adminChatId,
            message_id: messageIdToEdit,
            parse_mode: "Markdown",
          }
        );

        // Remove the buttons after action
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: adminChatId, message_id: messageIdToEdit }
        );
      } catch (editError) {
        if (
          editError.message &&
          editError.message.includes(
            "specific new message content and reply markup are exactly the same"
          )
        ) {
          // Ignore redundant edit
        } else {
          console.error(
            `Error editing admin message after approval for user ${targetUserId}:`,
            editError.message
          );
        }
      }
    } else {
      await bot.sendMessage(adminChatId, confirmationMessage);
    }
  } catch (error) {
    console.error(`Failed to approve user ${targetUserId}:`, error);

    if (error.response && error.response.body) {
      console.error("Telegram API Error Response Body:", error.response.body);
    }

    const errorMessage = `Failed to approve user ${targetUserId}. Error: ${error.message}`;

    if (messageIdToEdit && adminChatId) {
      try {
        await bot.editMessageCaption(
          errorMessage + "\n\n*STATUS: APPROVAL FAILED ❌*",
          {
            chat_id: adminChatId,
            message_id: messageIdToEdit,
            parse_mode: "Markdown",
          }
        );

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: adminChatId, message_id: messageIdToEdit }
        );
      } catch (editError) {
        if (
          editError.message &&
          editError.message.includes(
            "specific new message content and reply markup are exactly the same"
          )
        ) {
          // Ignore redundant edit
        } else {
          console.error(
            `Error editing admin message after failed approval for user ${targetUserId}:`,
            editError.message
          );
        }
      }
    } else {
      await bot.sendMessage(adminChatId, errorMessage);
    }
  }
}

// --- Reusable Decline Logic ---
async function handleDecline(
  targetUserId,
  adminChatId,
  messageIdToEdit = null
) {
  try {
    // Optional: Remove user from DB or mark as declined
    await Member.deleteOne({ userId: String(targetUserId) }); // Removes the user's entry from the DB

    await bot.sendMessage(
      targetUserId,
      `We regret to inform you that your payment could not be verified. Please ensure you have sent the correct payment confirmation screenshot or contact support.
+251908302638
`
    );

    const confirmationMessage = `User ${targetUserId} has been declined.`;

    if (messageIdToEdit && adminChatId) {
      try {
        await bot.editMessageCaption(
          confirmationMessage + "\n\n*STATUS: DECLINED ❌*",
          {
            chat_id: adminChatId,
            message_id: messageIdToEdit,
            parse_mode: "Markdown",
          }
        );

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: adminChatId, message_id: messageIdToEdit }
        );
      } catch (editError) {
        if (
          editError.message &&
          editError.message.includes(
            "specific new message content and reply markup are exactly the same"
          )
        ) {
          // Ignore redundant edit
        } else {
          console.error(
            `Error editing admin message after decline for user ${targetUserId}:`,
            editError.message
          );
        }
      }
    } else {
      await bot.sendMessage(adminChatId, confirmationMessage);
    }
  } catch (error) {
    console.error(`Failed to decline user ${targetUserId}:`, error.message);
    const errorMessage = `Failed to decline user ${targetUserId}. Error: ${error.message}`;

    if (messageIdToEdit && adminChatId) {
      try {
        await bot.editMessageCaption(
          errorMessage + "\n\n*STATUS: DECLINE FAILED ❌*",
          {
            chat_id: adminChatId,
            message_id: messageIdToEdit,
            parse_mode: "Markdown",
          }
        );

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: adminChatId, message_id: messageIdToEdit }
        );
      } catch (editError) {
        if (
          editError.message &&
          editError.message.includes(
            "specific new message content and reply markup are exactly the same"
            )
        ) {
          // Ignore redundant edit
        } else {
          console.error(
            `Error editing admin message after failed decline for user ${targetUserId}:`,
            editError.message
          );
        }
      }
    } else {
      await bot.sendMessage(adminChatId, errorMessage);
    }
  }
}

// --- Handle Inline Keyboard Button Clicks (Callback Queries) ---
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id; // Admin's chat ID
  const messageId = query.message.message_id; // The message with the buttons
  const data = query.data; // The callback_data string (e.g., "approve_12345")

  // --- IMPORTANT: Acknowledge the callback query IMMEDIATELY ---
  await bot.answerCallbackQuery(query.id); // This is crucial and must happen quickly

  // --- SECURITY CHECK: Only allow ADMIN_CHAT_ID to use these buttons ---
  if (String(chatId) !== String(ADMIN_CHAT_ID)) {
    await bot.sendMessage(
      chatId,
      "You are not authorized to use these buttons."
    );
    return;
  }

  // Parse the callback_data
  const parts = data.split(" "); // Splits "approve_12345" into ["approve", "12345"]
  const action = parts[0]; // "approve" or "decline"
  const targetUserId = parts[1]; // The user ID

  if (action === "approve_user") {
    await handleApproval(targetUserId, chatId, messageId);
  } else if (action === "decline_user") {
    await handleDecline(targetUserId, chatId, messageId);
  } else {
    await bot.sendMessage(chatId, "Unknown action.");
  }
});

// --- ADMIN COMMANDS (Fallback for manual typing, or if preferred) ---
// These now call the reusable functions
bot.onText(/\/approve_user (\d+)/, async (msg, match) => {
  const adminChatId = msg.chat.id;
  const targetUserId = match[1];

  if (String(adminChatId) !== String(ADMIN_CHAT_ID)) {
    return bot.sendMessage(
      adminChatId,
      "You are not authorized to use this command."
    );
  }

  await handleApproval(targetUserId, adminChatId);
});

bot.onText(/\/decline_user (\d+)/, async (msg, match) => {
  const adminChatId = msg.chat.id;
  const targetUserId = match[1];

  if (String(adminChatId) !== String(ADMIN_CHAT_ID)) {
    return bot.sendMessage(
      adminChatId,
      "You are not authorized to use this command.."
    );
  }

  await handleDecline(targetUserId, adminChatId);
});

// --- MongoDB: Function to check and remove expired members ---
async function removeExpiredMembers() {
  const nowTimestamp = Math.floor(Date.now() / 1000); // Current Unix timestamp

  try {
    // Find all members in the database who are 'active' and whose expiry timestamp is in the past
    const expiredMembers = await Member.find({
      status: "active",
      expiryTimestamp: { $lte: nowTimestamp },
    });

    if (expiredMembers.length === 0) {
      return;
    }

    for (const member of expiredMembers) {
      try {
        // Use bot.banChatMember to remove the user from the Telegram channel/group.
        // This removes them and prevents re-joining without a new invite/unban.
        await bot.banChatMember(CHANNEL_ID, member.userId);

        // Notify the user that their access has expired
        try {
          await bot.sendMessage(
            member.userId,
            `Your access to the Matu Channel has expired. Please contact us to renew your membership: +251908302638`
          );
        } catch (notifyError) {
          // Log error if notification fails (e.g., user blocked bot)
          console.error(
            `Failed to notify expired user ${member.userId}:`,
            notifyError.message
          );
        }

        // Update the member's status in MongoDB to 'expired'
        member.status = "expired";
        await member.save(); // Save the updated document to the database
      } catch (error) {
        // Handle cases where the user might already not be a member (e.g., they left manually)
        if (
          error.message.includes("not a member") ||
          error.message.includes("user not found")
        ) {
          member.status = "expired"; // Mark as expired in DB even if Telegram says they're gone
          await member.save();
        } else {
          // Log other errors, e.g., bot doesn't have 'Ban Users' permission
          console.error(`Check bot permissions for banning:`, error.message);
        }
      }
    }
  } catch (dbError) {
    console.error("Error querying MongoDB for expired members:", dbError);
  }
}

// --- Schedule the task to run periodically ---
// Set interval for checking expired members (e.g., every 12 hours)
// 12 hours * 60 minutes/hour * 60 seconds/minute * 1000 milliseconds/second
const SCHEDULE_INTERVAL = 12 * 60 * 60 * 1000;

// Run the check immediately when the bot starts, then repeatedly at the defined interval
removeExpiredMembers(); // Initial run
setInterval(removeExpiredMembers, SCHEDULE_INTERVAL);

// --- Keep Server Running with Periodic Requests (Self-Ping) ---
// This section creates a small HTTP server that your hosting platform can detect
// and also sends periodic requests to itself to prevent the service from sleeping.
const PORT = process.env.PORT || 3000; // Hosting platforms like Render will inject the PORT environment variable

const server = http.createServer((req, res) => {
    // This is a simple endpoint that can be hit by your hosting provider's health checks
    // or by the bot's own self-ping mechanism.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Matu Channel Bot is alive!\n');
});

server.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
});

const PING_INTERVAL = 50 * 1000; // 50 seconds in milliseconds

setInterval(() => {
    // Make an HTTP GET request to the SERVER_URL (which should be your deployed app's URL)
    // This keeps the server active on platforms that might put it to sleep due to inactivity.
    http.get(SERVER_URL, (res) => {
        // Consume response data to free up memory
        res.on('data', () => {});
        res.on('end', () => {});
    }).on('error', (e) => {
        console.error(`Error during self-ping to ${SERVER_URL}: ${e.message}`);
    });
}, PING_INTERVAL);


// --- General Error Handling for the Bot ---
bot.on("polling_error", (error) => {
  console.error("Polling error:", error.code, error.message);
});

bot.on("webhook_error", (error) => {
  console.error("Webhook error:", error.code, error.message);
});
