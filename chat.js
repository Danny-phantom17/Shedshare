"use strict";

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const config = require("./chat-config");
const { redactContactDetails } = require("./privacy");

const id = z.string().regex(/^\d+$/, "Invalid id.");
function fail(res, status, error) { return res.status(status).json({ error }); }
function imageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
function conversationKey(kind, ...ids) { return crypto.createHash("sha256").update(`${kind}:${ids.join(":")}`).digest("hex"); }
function createChatRouter({ pool, authenticate, supabase }) {
  const router = express.Router(), auth = [authenticate];
  // The limiter MUST run after `authenticate` (see the route order below) because it keys on req.user.id.
  // The fallback keeps it from throwing if req.user is ever missing, which previously caused
  // "An unexpected server error occurred." when sending a message.
  const messageLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.messagesPerMinute,
    max: config.messagesPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => (req.user && req.user.id != null ? `user:${req.user.id}` : "user:anonymous"),
    message: { error: "You are sending messages too quickly. Wait a moment and try again." }
  });
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: config.maxImageBytes } });

  async function participant(conversationId, userId) {
    const [rows] = await pool.execute("SELECT c.id,c.kind,c.item_id,c.rental_id,c.delivery_id,c.locked_at,c.closed_at,cp.last_read_message_id FROM conversations c JOIN conversation_participants cp ON cp.conversation_id=c.id WHERE c.id=? AND cp.user_id=?", [conversationId,userId]);
    return rows[0] || null;
  }
  async function adminRead(conversationId, req, res, reason, mode) {
    if (!new Set(["super_admin", "trust_and_safety"]).has(req.user.trustRole)) return fail(res,403,"Dedicated trust and safety access is required.");
    await pool.execute("INSERT INTO chat_admin_access (conversation_id,admin_id,access_reason,access_mode,trust_role) VALUES (?,?,?,?,?)", [conversationId,req.user.id,reason,mode,req.user.trustRole]);
    return true;
  }
  function isClosed(c) { return c.closed_at || (c.locked_at && new Date(c.locked_at).getTime() <= Date.now()); }

  router.post("/messages/conversations", ...auth, async (req,res) => {
    const parsed=z.object({ itemId:id, otherUserId:id.optional(), rentalId:id.optional() }).strict().safeParse(req.body);
    if(!parsed.success)return fail(res,400,"Choose a listing and conversation participant.");
    const d=parsed.data, userId=String(req.user.id);
    try {
      const [items]=await pool.execute("SELECT id,owner_id,name,paused FROM items WHERE id=?",[d.itemId]);
      if(!items.length)return fail(res,404,"Listing not found.");
      const ownerId=String(items[0].owner_id), renterId=userId===ownerId?String(d.otherUserId||""):userId;
      if(!renterId||renterId===ownerId||(userId!==ownerId&&d.otherUserId&&String(d.otherUserId)!==ownerId))return fail(res,403,"Only a renter can start a conversation about this listing.");
      if(userId===ownerId){
        const [r]=await pool.execute("SELECT id FROM rentals WHERE id=? AND item_id=? AND owner_id=? AND renter_id=?",[d.rentalId||"0",d.itemId,ownerId,renterId]);
        if(!r.length)return fail(res,403,"A lister can start this chat only for an existing rental.");
      }
      if(d.rentalId){
        const [r]=await pool.execute("SELECT id,updated_at,status FROM rentals WHERE id=? AND item_id=? AND owner_id=? AND renter_id=?",[d.rentalId,d.itemId,ownerId,renterId]);
        if(!r.length)return fail(res,403,"That rental does not belong to this conversation.");
      }
      if(items[0].paused && !d.rentalId)return fail(res,409,"This listing is paused and cannot receive new enquiries.");
      let rentalId=d.rentalId||null;
      if(!rentalId) { const [r]=await pool.execute("SELECT id FROM rentals WHERE item_id=? AND owner_id=? AND renter_id=? AND status IN ('pending_payment','confirmed','active','completed') ORDER BY created_at DESC LIMIT 1",[d.itemId,ownerId,renterId]); rentalId=r[0]?.id||null; }
      let completedLockAt=null;
      if(rentalId){const [r]=await pool.execute("SELECT status,DATE_ADD(updated_at,INTERVAL ? DAY) AS lock_at FROM rentals WHERE id=?",[config.completionLockDays,rentalId]);if(r[0]?.status==="completed")completedLockAt=r[0].lock_at;}
      const key=conversationKey("item",d.itemId,ownerId,renterId);
      await pool.execute("INSERT INTO conversations (conversation_key,kind,item_id,rental_id,locked_at,created_by) VALUES (?,'item',?,?,?,?) ON DUPLICATE KEY UPDATE rental_id=COALESCE(VALUES(rental_id),rental_id),locked_at=COALESCE(locked_at,VALUES(locked_at))",[key,d.itemId,rentalId,completedLockAt,req.user.id]);
      const [c]=await pool.execute("SELECT id FROM conversations WHERE conversation_key=?",[key]);
      await pool.execute("INSERT IGNORE INTO conversation_participants (conversation_id,user_id) VALUES (?,?),(?,?)",[c[0].id,ownerId,c[0].id,renterId]);
      const [other]=await pool.execute("SELECT id,name FROM users WHERE id=?",[userId===ownerId?renterId:ownerId]);
      return res.status(201).json({conversationId:String(c[0].id),itemId:d.itemId,itemName:items[0].name,withUserId:String(other[0].id),withUserName:other[0].name});
    } catch(e){console.error("Creating conversation failed:",e.message);return fail(res,500,"Unable to open this conversation.");}
  });

  router.get("/messages/conversations",...auth,async(req,res)=>{
    try{
      const [rows]=await pool.execute(`SELECT c.id,c.kind,c.item_id,c.rental_id,c.delivery_id,c.locked_at,c.closed_at,i.name AS item_name,i.image AS image_url,
        cp2.user_id AS other_id,u.name AS other_name,MAX(m.id) AS latest_id,MAX(m.created_at) AS latest_at,
        SUM(CASE WHEN m.id>COALESCE(cp.last_read_message_id,0) AND m.sender_id<>? THEN 1 ELSE 0 END) AS unread_count,
        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN m.id IS NOT NULL THEN m.body END ORDER BY m.id DESC SEPARATOR '\\n'), '\\n', 1) AS last_message
        FROM conversation_participants cp JOIN conversations c ON c.id=cp.conversation_id
        JOIN conversation_participants cp2 ON cp2.conversation_id=c.id AND cp2.user_id<>cp.user_id
        JOIN users u ON u.id=cp2.user_id LEFT JOIN items i ON i.id=c.item_id
        LEFT JOIN chat_messages m ON m.conversation_id=c.id
        WHERE cp.user_id=? GROUP BY c.id,c.kind,c.item_id,c.rental_id,c.delivery_id,c.locked_at,c.closed_at,i.name,i.image,cp2.user_id,u.name
        ORDER BY COALESCE(MAX(m.id),c.id) DESC LIMIT 100`,[req.user.id,req.user.id]);
      return res.json(rows.map(r=>({conversationId:String(r.id),kind:r.kind,deliveryId:r.delivery_id==null?null:String(r.delivery_id),itemId:r.item_id==null?null:String(r.item_id),itemName:r.item_name||"Delivery chat",thumbnail:r.image_url||"",otherUserId:String(r.other_id),otherUserName:r.other_name,lastMessage:r.last_message||"",lastMessageAt:r.latest_at?new Date(r.latest_at).toISOString():null,unreadCount:Number(r.unread_count||0),locked:Boolean(isClosed(r))})));
    }catch(e){console.error("Loading conversations failed:",e.message);return fail(res,500,"Unable to load conversations.");}
  });

  router.get("/messages/unread-count",...auth,async(req,res)=>{
    try{
      const [rows]=await pool.execute(`SELECT COUNT(m.id) AS unread_messages
        FROM conversation_participants cp
        JOIN chat_messages m ON m.conversation_id=cp.conversation_id
          AND m.sender_id<>cp.user_id
          AND m.id>COALESCE(cp.last_read_message_id,0)
        WHERE cp.user_id=?`,[req.user.id]);
      return res.json({unreadMessages:Number(rows[0]?.unread_messages||0)});
    }catch(e){console.error("Loading unread message count failed:",e.message);return fail(res,500,"Unable to load unread message count.");}
  });

  router.get("/messages/conversations/:id",...auth,async(req,res)=>{
    const conversationId=id.safeParse(req.params.id);if(!conversationId.success)return fail(res,400,"Invalid conversation.");
    try{const c=await participant(conversationId.data,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");const [rows]=await pool.execute("SELECT c.id,c.item_id,i.name item_name,cp2.user_id other_id,u.name other_name FROM conversations c JOIN conversation_participants cp2 ON cp2.conversation_id=c.id AND cp2.user_id<>? JOIN users u ON u.id=cp2.user_id LEFT JOIN items i ON i.id=c.item_id WHERE c.id=? LIMIT 1",[req.user.id,c.id]);if(!rows.length)return fail(res,404,"Conversation not found.");return res.json({conversationId:String(c.id),itemId:String(rows[0].item_id),itemName:rows[0].item_name,withUserId:String(rows[0].other_id),withUserName:rows[0].other_name});}catch(e){console.error("Loading conversation details failed:",e.message);return fail(res,500,"Unable to load conversation.");}
  });

  router.get("/messages/agreements",...auth,async(req,res)=>{
    const conversationId=id.safeParse(String(req.query.conversationId||""));if(!conversationId.success)return fail(res,400,"A valid conversation is required.");try{const c=await participant(conversationId.data,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");await pool.execute("UPDATE rental_agreement_versions SET status='expired' WHERE rental_id=? AND status IN ('pending','accepted') AND expires_at IS NOT NULL AND expires_at<=UTC_TIMESTAMP()",[c.rental_id||0]);const [rows]=await pool.execute(`SELECT av.id,av.rental_id,av.version,av.terms,av.renter_accepted_at,av.owner_accepted_at,av.status offer_status,av.created_by,av.expires_at,av.created_at,r.status rental_status,r.renter_id,r.owner_id FROM rental_agreement_versions av JOIN rentals r ON r.id=av.rental_id WHERE r.id=? AND (r.renter_id=? OR r.owner_id=?) ORDER BY av.version DESC`,[c.rental_id||0,req.user.id,req.user.id]);return res.json(rows.map(a=>({id:String(a.id),rentalId:String(a.rental_id),version:a.version,terms:typeof a.terms==="string"?JSON.parse(a.terms):a.terms,renterAccepted:Boolean(a.renter_accepted_at),ownerAccepted:Boolean(a.owner_accepted_at),ready:Boolean(a.renter_accepted_at&&a.owner_accepted_at),status:a.offer_status,rentalStatus:a.rental_status,createdBy:String(a.created_by),ownerId:String(a.owner_id),renterId:String(a.renter_id),expiresAt:a.expires_at?new Date(a.expires_at).toISOString():null,createdAt:new Date(a.created_at).toISOString()})));}catch(e){console.error("Loading rental summaries failed:",e.message);return fail(res,500,"Unable to load rental summaries.");}
  });

  async function getMessages(conversationId,user,res,markRead=true,afterId="0"){
    const c=await participant(conversationId,user.id); if(!c)return fail(res,403,"You are not a participant in this conversation.");
    const [blocks]=await pool.execute("SELECT 1 FROM chat_blocks WHERE conversation_id=? AND (blocker_id=? OR blocked_user_id=?) LIMIT 1",[conversationId,user.id,user.id]);
    const [rental]=c.rental_id?await pool.execute("SELECT payment_verified_at,status FROM rentals WHERE id=?",[c.rental_id]):[[]];
    const paid=Boolean(rental[0]?.payment_verified_at)||["confirmed","active","completed"].includes(rental[0]?.status);
    const [rows]=await pool.execute(`SELECT m.id,m.sender_id,m.body,m.attachment_path,m.attachment_mime,m.created_at,u.name AS sender_name
      FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND m.id>? ORDER BY m.id ASC LIMIT 500`,[conversationId,afterId]);
    const [readRows]=await pool.execute("SELECT MAX(last_read_message_id) AS read_id FROM conversation_participants WHERE conversation_id=? AND user_id<>?",[conversationId,user.id]);
    if(markRead&&rows.length)await pool.execute("UPDATE conversation_participants SET last_read_message_id=GREATEST(COALESCE(last_read_message_id,0),?) WHERE conversation_id=? AND user_id=?",[rows[rows.length-1].id,conversationId,user.id]);
    return rows.map(m=>({id:String(m.id),senderId:String(m.sender_id),senderName:m.sender_name,text:paid?m.body:redactContactDetails(m.body),contactDetailsMasked:!paid,blocked:Boolean(blocks.length),attachment:m.attachment_path?{url:`/api/messages/${m.id}/attachment`,mimeType:m.attachment_mime}:null,createdAt:new Date(m.created_at).toISOString(),sent:true,read:String(m.sender_id)===String(user.id)&&Number(m.id)<=Number(readRows[0]?.read_id||0)}));
  }

  router.get("/messages",...auth,async(req,res)=>{
    const c=id.safeParse(req.query.conversationId),after=id.safeParse(String(req.query.afterId||"0"));
    if(!c.success||!after.success)return fail(res,400,"A valid conversation is required.");
    try{const data=await getMessages(c.data,req.user,res,true,after.data);if(!Array.isArray(data))return;return res.json(data);}
    catch(e){console.error("Loading chat failed:",e.message);return fail(res,500,"Unable to load conversation.");}
  });

  // Order matters: authenticate FIRST, then the rate limiter (it reads req.user.id).
  router.post("/messages",...auth,messageLimiter,async(req,res)=>{
    const parsed=z.object({conversationId:id,text:z.string().trim().max(4000).optional().default(""),attachmentMessage:z.boolean().optional().default(false)}).strict().safeParse(req.body);
    if(!parsed.success||(!parsed.data.text&&!parsed.data.attachmentMessage))return fail(res,400,"Write a message or attach a photo.");
    try{
      const c=await participant(parsed.data.conversationId,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");
      if(isClosed(c))return fail(res,423,"This conversation is closed.");
      const [blocked]=await pool.execute("SELECT 1 FROM chat_blocks WHERE conversation_id=? LIMIT 1",[c.id]);if(blocked.length)return fail(res,423,"Messaging is blocked in this conversation.");
      const [rental]=c.rental_id?await pool.execute("SELECT payment_verified_at,status FROM rentals WHERE id=?",[c.rental_id]):[[]];
      const paid=Boolean(rental[0]?.payment_verified_at)||["confirmed","active","completed"].includes(rental[0]?.status);
      const text=paid?parsed.data.text:redactContactDetails(parsed.data.text);
      const [result]=await pool.execute("INSERT INTO chat_messages (conversation_id,sender_id,body) VALUES (?,?,?)",[c.id,req.user.id,text]);
      const [recipients]=await pool.execute("SELECT user_id FROM conversation_participants WHERE conversation_id=? AND user_id<>?",[c.id,req.user.id]);
      try{for(const recipient of recipients){
        const [recent]=await pool.execute("SELECT id FROM notifications WHERE user_id=? AND type='chat_message' AND related_id=? AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? MINUTE) LIMIT 1",[recipient.user_id,c.id,config.notificationBatchMinutes]);
        if(!recent.length)await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'chat_message','You have a new ShedShare message.',?)",[recipient.user_id,c.id]);
      }}catch(_notificationError){/* Message delivery is independent from notification delivery. */}
      return res.status(201).json({id:String(result.insertId),conversationId:String(c.id),senderId:String(req.user.id),text,createdAt:new Date().toISOString(),sent:true,read:false});
    }catch(e){console.error("Sending chat message failed:",e.message);return fail(res,500,"Unable to send message.");}
  });

  router.post("/messages/:id/attachment",...auth,messageLimiter,(req,res,next)=>imageUpload.single("image")(req,res,error=>{if(error instanceof multer.MulterError&&error.code==="LIMIT_FILE_SIZE")return fail(res,413,"Chat photos must be 5 MiB or smaller.");if(error)return fail(res,400,"Invalid photo upload.");next();}),async(req,res)=>{
    const messageId=id.safeParse(req.params.id);if(!messageId.success||!req.file)return fail(res,400,"Choose a photo to upload.");
    if(!supabase)return fail(res,503,"Private photo storage is not configured.");
    const mime=imageType(req.file.buffer);if(!mime)return fail(res,415,"Upload a JPEG, PNG, or WebP photo.");
    try{
      const [rows]=await pool.execute("SELECT m.conversation_id,c.rental_id,c.locked_at,c.closed_at FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.sender_id=?",[messageId.data,req.user.id]);
      if(!rows.length)return fail(res,404,"Message not found.");const c=await participant(rows[0].conversation_id,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");if(isClosed(c))return fail(res,423,"This conversation is closed.");
      const path=`${c.id}/${req.user.id}/${crypto.randomUUID()}.${mime.split("/")[1]}`;
      const {error}=await supabase.storage.from(config.privateBucket).upload(path,req.file.buffer,{contentType:mime,upsert:false,cacheControl:"0"});if(error)throw error;
      await pool.execute("UPDATE chat_messages SET attachment_path=?,attachment_mime=?,attachment_name=? WHERE id=?",[path,mime,req.file.originalname.slice(0,180),messageId.data]);
      return res.status(201).json({messageId:messageId.data});
    }catch(e){console.error("Uploading private chat photo failed:",e.message);return fail(res,500,"Unable to upload this photo.");}
  });

  router.get("/messages/:id/attachment",...auth,async(req,res)=>{
    const messageId=id.safeParse(req.params.id);if(!messageId.success)return fail(res,400,"Invalid message id.");
    try{
      const [rows]=await pool.execute("SELECT m.conversation_id,m.attachment_path,m.attachment_mime,c.locked_at,c.closed_at FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",[messageId.data]);if(!rows.length||!rows[0].attachment_path)return fail(res,404,"Photo not found.");
      const c=await participant(rows[0].conversation_id,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");
      const {data,error}=await supabase.storage.from(config.privateBucket).download(rows[0].attachment_path);if(error)throw error;
      const buffer=Buffer.from(await data.arrayBuffer());res.set({"Content-Type":rows[0].attachment_mime,"Content-Length":buffer.length,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});return res.send(buffer);
    }catch(e){console.error("Reading private chat photo failed:",e.message);return fail(res,500,"Unable to load this photo.");}
  });

  router.get("/messages/stream",...auth,async(req,res)=>{
    const cId=id.safeParse(req.query.conversationId);if(!cId.success)return fail(res,400,"A valid conversation is required.");
    const c=await participant(cId.data,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");
    if(isClosed(c))return fail(res,423,"This conversation is closed.");
    res.status(200).set({"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});res.flushHeaders();res.write(": connected\n\n");
    let after=String(req.query.afterId||"0"),lastReadSent=0,busy=false;
    const send=async()=>{if(busy||res.writableEnded)return;busy=true;try{const still=await participant(cId.data,req.user.id);if(!still||isClosed(still)){res.write("event: closed\ndata: {}\n\n");return res.end();}const rows=await getMessages(cId.data,req.user,res,true,after);if(Array.isArray(rows)&&rows.length){after=rows[rows.length-1].id;res.write(`event: messages\ndata: ${JSON.stringify(rows)}\n\n`);}const [readRows]=await pool.execute("SELECT MAX(last_read_message_id) AS read_id FROM conversation_participants WHERE conversation_id=? AND user_id<>?",[cId.data,req.user.id]);const readId=Number(readRows[0]?.read_id||0);if(readId>lastReadSent){lastReadSent=readId;res.write(`event: read\ndata: ${JSON.stringify({lastReadMessageId:String(readId)})}\n\n`);}if(!rows?.length)res.write(": heartbeat\n\n");}catch(_e){res.write("event: unavailable\ndata: {}\n\n");res.end();}finally{busy=false;}};
    send();const timer=setInterval(send,config.streamPollMs);req.on("close",()=>clearInterval(timer));
  });

  router.post("/messages/conversations/:id/block",...auth,async(req,res)=>{
    const conversationId=id.safeParse(req.params.id);if(!conversationId.success)return fail(res,400,"Invalid conversation.");
    try{const c=await participant(conversationId.data,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");const [other]=await pool.execute("SELECT user_id FROM conversation_participants WHERE conversation_id=? AND user_id<>? LIMIT 1",[c.id,req.user.id]);if(!other.length)return fail(res,409,"This conversation has no other participant.");await pool.execute("INSERT IGNORE INTO chat_blocks (conversation_id,blocker_id,blocked_user_id) VALUES (?,?,?)",[c.id,req.user.id,other[0].user_id]);return res.json({blocked:true});}
    catch(e){console.error("Blocking chat participant failed:",e.message);return fail(res,500,"Unable to block this participant.");}
  });

  router.post("/messages/conversations/:id/report",...auth,async(req,res)=>{
    const conversationId=id.safeParse(req.params.id),reason=z.string().trim().min(3).max(500).safeParse(req.body?.reason||"");if(!conversationId.success||!reason.success)return fail(res,400,"Add a short reason for the report.");
    try{const c=await participant(conversationId.data,req.user.id);if(!c)return fail(res,403,"You are not a participant in this conversation.");await pool.execute("INSERT INTO chat_reports (conversation_id,reporter_id,reason) VALUES (?,?,?)",[c.id,req.user.id,reason.data]);return res.status(201).json({reported:true});}
    catch(e){console.error("Reporting chat failed:",e.message);return fail(res,500,"Unable to report this conversation.");}
  });

  router.get("/admin/conversations/:id",...auth,async(req,res)=>{
    const conversationId=id.safeParse(req.params.id);const reason=z.string().trim().min(5).max(500).safeParse(req.query.reason||"");const mode=z.enum(["reported","dispute","safety_review","fraud_check","other"]).safeParse(req.query.mode||"other");if(!conversationId.success||!reason.success||!mode.success)return fail(res,400,"Provide a valid conversation, access reason, and review category.");if(!req.user.isAdmin)return fail(res,403,"Administrator access required.");if(!new Set(["super_admin","trust_and_safety"]).has(req.user.trustRole))return fail(res,403,"Dedicated trust and safety access is required.");
    try{const [exists]=await pool.execute("SELECT id FROM conversations WHERE id=?",[conversationId.data]);if(!exists.length)return fail(res,404,"Conversation not found.");await adminRead(conversationId.data,req,res,reason.data,mode.data);const [rows]=await pool.execute("SELECT m.id,m.sender_id,u.name AS sender_name,m.body,m.created_at FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.id LIMIT 500",[conversationId.data]);const [privates]=await pool.execute("SELECT body FROM chat_messages WHERE conversation_id=?",[conversationId.data]);const sensitive=[...privates.map(x=>x.body)].filter(x=>/\b\d{8,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(x)).join(" ");const masker=redactContactDetails(sensitive);return res.json(rows.map(m=>({id:String(m.id),senderId:String(m.sender_id),senderName:m.sender_name,text:redactContactDetails(m.body),createdAt:new Date(m.created_at).toISOString(),attachment:false,sensitiveDetailsMasked:masker!==sensitive})));}
    catch(e){console.error("Admin chat dispute review failed:",e.message);return fail(res,500,"Unable to load dispute conversation.");}
  });

  router.get("/admin/chat-reports",...auth,async(req,res)=>{
    if(!req.user.isAdmin)return fail(res,403,"Administrator access required.");if(!new Set(["super_admin","trust_and_safety"]).has(req.user.trustRole))return fail(res,403,"Dedicated trust and safety access is required.");
    try{const [rows]=await pool.execute("SELECT cr.id,cr.conversation_id,cr.reason,cr.status,cr.created_at,u.name AS reporter_name FROM chat_reports cr JOIN users u ON u.id=cr.reporter_id ORDER BY cr.created_at DESC LIMIT 200");return res.json(rows.map(r=>({id:String(r.id),conversationId:String(r.conversation_id),reason:r.reason,status:r.status,reporterName:r.reporter_name,createdAt:new Date(r.created_at).toISOString()})));}
    catch(e){console.error("Loading chat reports failed:",e.message);return fail(res,500,"Unable to load chat reports.");}
  });

  router.get("/admin/disputed-conversations",...auth,async(req,res)=>{
    if(!req.user.isAdmin)return fail(res,403,"Administrator access required.");if(!new Set(["super_admin","trust_and_safety"]).has(req.user.trustRole))return fail(res,403,"Dedicated trust and safety access is required.");
    try{const [rows]=await pool.execute("SELECT d.id dispute_id,d.rental_id,d.reason,d.status,d.created_at,c.id conversation_id,r.item_name FROM rental_disputes d JOIN rentals r ON r.id=d.rental_id JOIN conversations c ON c.rental_id=r.id AND c.kind='item' WHERE d.status IN ('open','reviewing') ORDER BY d.created_at DESC LIMIT 200");return res.json(rows.map(r=>({disputeId:String(r.dispute_id),rentalId:String(r.rental_id),conversationId:String(r.conversation_id),itemName:r.item_name,reason:r.reason,status:r.status,createdAt:new Date(r.created_at).toISOString()})));}
    catch(e){console.error("Loading disputed conversations failed:",e.message);return fail(res,500,"Unable to load disputed conversations.");}
  });

  // Last-resort handler for this router: logs the REAL cause in your terminal and
  // replies with JSON instead of the generic "unexpected server error".
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(`Chat route failed (${req.method} ${req.originalUrl}):`, error && error.stack ? error.stack : error);
    return fail(res, 500, "Chat is temporarily unavailable. Please try again.");
  });

  return router;
}

async function ensureDeliveryConversations(connection, deliveryId, actorId) {
  const [rows]=await connection.execute("SELECT d.id,d.rental_id,r.item_id,r.renter_id,r.owner_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=?",[deliveryId]);
  if(!rows.length)return;
  const d=rows[0];
  for(const [kind,otherId] of [["delivery_renter",d.renter_id],["delivery_owner",d.owner_id]]){
    const key=conversationKey(kind,d.id,otherId,actorId);
    await connection.execute("INSERT INTO conversations (conversation_key,kind,item_id,rental_id,delivery_id,created_by) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE closed_at=NULL",[key,kind,d.item_id,d.rental_id,d.id,actorId]);
    const [c]=await connection.execute("SELECT id FROM conversations WHERE conversation_key=?",[key]);
    await connection.execute("INSERT IGNORE INTO conversation_participants (conversation_id,user_id) VALUES (?,?),(?,?)",[c[0].id,otherId,c[0].id,actorId]);
  }
}

module.exports={createChatRouter,ensureDeliveryConversations};
