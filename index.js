const line = require('@line/bot-sdk');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const axios = require('axios');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const crypto = require('crypto');
const mqtt = require('mqtt');

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Middleware to log request headers and body for debugging
app.use((req, res, next) => {
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    next();
});

const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

// Create connection to MySQL
const createConnection = async () => {
    return await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '1234',
        database: 'accident_bot'
    });
};

let clients = mqtt.connect(`mqtt://${process.env.MQTT_BROKER}`);
let topic = process.env.MQTT_TOPIC;

// Function to verify LINE signature
const verifySignature = (body, signature) => {
    const hash = crypto.createHmac('SHA256', lineConfig.channelSecret)
        .update(body)
        .digest('base64');
    return signature === hash;
};

// Webhook for LINE messages
app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-line-signature'];

    // Verify the signature
    const body = JSON.stringify(req.body);
    if (!verifySignature(body, signature)) {
        console.error('Invalid signature');
        return res.status(401).send('Unauthorized');
    }

    try {
        const events = req.body.events;

        if (events.length > 0) {
            await Promise.all(events.map(handleEvent));
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Webhook for SOS messages
const sendLineMessage = async (data) => {
    let token, name, user_id;

    try {
        const connection = await createConnection();
        const [rows] = await connection.execute(
            `SELECT tbl_group.line_token, user.name, devices.userId 
            FROM devices
            JOIN user ON user.id = devices.userId
            JOIN tbl_group ON tbl_group.id = user.group_id
            WHERE devices.device_id = ?`, [data.Device_ID]);

        if (rows.length === 0) {
            console.error('Device not found');
            return;
        }

        token = rows[0].line_token;
        name = rows[0].name;
        user_id = rows[0].userId;
        console.log('Token ===> ', token);
        
        await connection.end();
    } catch (error) {
        console.error('Error fetching data from MySQL:', error);
        return;
    }

    const datetime_now = moment().tz("Asia/Bangkok").format('YYYY-MM-DD HH:mm:ss');
    const data_insert = {
        userId: user_id,
        createdAt: datetime_now,
        updatedAt: datetime_now,
        fk_device_id: data.Device_ID,
        latitude: data.Latitude,
        longtitude: data.Longitude,
        level: data.Level_detection
    };

    await insertData(data_insert);

    let message = `\nผู้ใช้งาน: ${name}\nความรุนแรง: ${data.Level_detection}\nได้รับประสบอุบัติเหตุเมื่อเวลา: ${datetime_now}\nสถานที่เกิดอุบัติเหตุ: https://www.google.co.th/maps/place/${data.Latitude},${data.Longitude}`;

    try {
        await axios.post('https://notify-api.line.me/api/notify',
          new URLSearchParams({ message }),{ 
            headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${token}`
            }
        });
        console.log('Message sent to LINE');
    } catch (err) {
        console.error('Error sending message to LINE:', err);
    }
};

// Insert data into MySQL
async function insertData(data) {
    const connection = await createConnection();
    const { userId, createdAt, updatedAt, fk_device_id, latitude, longtitude, level } = data;
    const sql = 'INSERT INTO history (userId, createdAt, updatedAt, fk_device_id, latitude, longtitude, level) VALUES (?, ?, ?, ?, ?, ?, ?)';

    try {
        await connection.execute(sql, [userId, createdAt, updatedAt, fk_device_id, latitude, longtitude, level]);
        console.log('Data inserted into MySQL');
    } catch (err) {
        console.error('Error inserting data into MySQL:', err);
    } finally {
        await connection.end();
    }
}

// Handle incoming LINE events
const handleEvent = async (event) => {
    if (event.type === 'message' && event.message.type === 'text') {
        if ((event.message.text === 'groupId') || (event.message.text === 'GroupId')) {
            try {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'GROUP ID: ' + event.source.groupId
                });
            } catch (error) {
                console.error('Error replying message:', error);
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'เกิดข้อผิดพลาดในการแสดงผลข้อมูล'
                });
            }
        } else if (event.message.text === 'เรียกดูประวัติ') {
            await fetchHistory(event);
        }
    }
};

// Fetch accident history
const fetchHistory = async (event) => {
    const connection = await createConnection();
    try {
        const [rows] = await connection.execute(
            `SELECT 
                history.createdAt, 
                history.latitude, 
                history.longtitude, 
                history.level, 
                user.name 
            FROM tbl_group
            JOIN user ON user.group_id = tbl_group.id
            JOIN history ON history.userId = user.id
            WHERE tbl_group.group_lineId = ?
            ORDER BY history.createdAt DESC
            LIMIT 1`, [event.source.groupId]);

        console.log('Fetched rows:', rows);

        if (rows.length > 0) {
            const row = rows[0];
            const localCreatedAt = moment(row.createdAt).tz("Asia/Bangkok").format('YYYY-MM-DD HH:mm:ss');

            const flexMessage = {
                type: "flex",
                altText: "รายงานประวัติอุบัติเหตุ",
                contents: {
                    type: "bubble",
                    size: "mega",
                    header: {
                        type: "box",
                        layout: "vertical",
                        contents: [{
                            type: "text",
                            text: "รายงานประวัติอุบัติเหตุ",
                            weight: "bold",
                            size: "lg",
                            color: "#FFFFFF"
                        }],
                        backgroundColor: "#2E8B57", // สีเขียวเข้ม
                        paddingAll: "20px",
                        paddingTop: "22px",
                        height: "72px"
                    },
                    hero: {
                        type: "image",
                        url: "https://cdn.pixabay.com/photo/2015/06/03/13/38/plymouth-796441_1280.jpg", // Update with your actual image URL if different
                        size: "full",
                        aspectRatio: "20:13",
                        aspectMode: "cover"
                    },
                    body: {
                        type: "box",
                        layout: "vertical",
                        paddingAll: "20px",
                        spacing: "sm",
                        contents: [
                            {
                                type: "box",
                                layout: "vertical",
                                contents: [
                                    {
                                        type: "box",
                                        layout: "horizontal",
                                        spacing: "sm",
                                        contents: [
                                            {
                                                type: "text",
                                                text: "ชื่อ",
                                                size: "sm",
                                                color: "#2F4F4F",
                                                flex: 1,
                                                weight: "bold"
                                            },
                                            {
                                                type: "text",
                                                text: row.name,  // Name data here
                                                size: "sm",
                                                color: "#1F2937",
                                                flex: 2,
                                                wrap: true
                                            }
                                        ]
                                    },
                                    {
                                        type: "box",
                                        layout: "horizontal",
                                        spacing: "sm",
                                        contents: [
                                            {
                                                type: "text",
                                                text: "วันที่",
                                                size: "sm",
                                                color: "#2F4F4F",
                                                flex: 1,
                                                weight: "bold"
                                            },
                                            {
                                                type: "text",
                                                text: localCreatedAt,  // Date data here
                                                size: "sm",
                                                color: "#1F2937",
                                                flex: 2,
                                                wrap: true
                                            }
                                        ]
                                    },
                                    {
                                        type: "box",
                                        layout: "horizontal",
                                        spacing: "sm",
                                        contents: [
                                            {
                                                type: "text",
                                                text: "ระดับ",
                                                size: "sm",
                                                color: "#2F4F4F",
                                                flex: 1,
                                                weight: "bold"
                                            },
                                            {
                                                type: "text",
                                                text: row.level,  // Level data here
                                                size: "sm",
                                                color: row.level === 'high' ? '#FF0000' : '#2E8B57',  // Red for high, Green for low
                                                flex: 2,
                                                wrap: true
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    },
                    footer: {
                        type: "box",
                        layout: "vertical",
                        spacing: "sm",
                        contents: [
                            {
                                type: "button",
                                action: {
                                    type: "uri",
                                    label: "ดูตำแหน่งบน Google Maps",
                                    uri: `https://www.google.co.th/maps/place/${row.latitude},${row.longtitude}`  // Dynamic lat/long values
                                },
                                style: "primary",
                                color: "#2E8B57",  // Green background
                                height: "sm"
                            },
                            {
                                type: "button",
                                action: {
                                    type: "uri",
                                    label: "ดูรายละเอียดเพิ่มเติม",
                                    uri: "https://your-website-url.com"  // Your website link here
                                },
                                style: "secondary",
                                color: "#FFFFFF",  // White text for secondary button
                                height: "sm"
                            }
                        ]
                    }
                }
            };

            await client.replyMessage(event.replyToken, flexMessage);
        } else {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'ไม่พบประวัติการบันทึก'
            });
        }
    } catch (err) {
        console.error('Error fetching history:', err);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'เกิดข้อผิดพลาดในการดึงข้อมูลประวัติ'
        });
    } finally {
        await connection.end();
    }
};

// Connect to MQTT and subscribe to the topic
clients.on('connect', () => {
    clients.subscribe(topic, (err) => {
        if (!err) {
            console.log(`Connected to MQTT broker and subscribed to topic: ${topic}`);
        }
    });
});

// Handle incoming MQTT messages
clients.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        console.log('Received MQTT message:', payload);

        // Call the sendLineMessage function with the parsed payload
        await sendLineMessage(payload);
    } catch (error) {
        console.error('Error processing MQTT message:', error);
    }
});

// Start the Express server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
