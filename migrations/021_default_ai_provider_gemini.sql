UPDATE ai_control_settings
   SET provider='gemini'
 WHERE setting_id=1 AND enabled=FALSE;
