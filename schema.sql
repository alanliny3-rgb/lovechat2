-- ============================================================
-- lovechat · Supabase 建库脚本（GitHub Pages 纯静态 + Supabase 直连）
-- 用法：Supabase 控制台 → SQL Editor → 整段粘贴 → Run
-- 说明：所有数据读写都通过下面的 RPC 函数完成，前端不直接碰表，
--       因此不需要 Edge Function / 任何服务器。表开启了 RLS 但不建
--       任何 policy，anon 无法直接读表，只能调用函数。
-- ============================================================

-- ---------- 1. 表结构（与原来 Railway Postgres 一致） ----------
CREATE TABLE IF NOT EXISTS public.users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  avatar TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS public.friends (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  friend_id INT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  remark TEXT,
  UNIQUE(user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id SERIAL PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  ts BIGINT DEFAULT (EXTRACT(EPOCH FROM now())*1000)
);

CREATE TABLE IF NOT EXISTS public.unread_counts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  from_user_id INT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  count INT DEFAULT 0,
  UNIQUE(user_id, from_user_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_pair ON public.messages (from_user, to_user, id DESC);
CREATE INDEX IF NOT EXISTS idx_unread_pair  ON public.unread_counts (user_id, from_user_id);

-- ---------- 2. 行级安全：启用 RLS 但不给 anon/authenticated 任何策略 ----------
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friends       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unread_counts ENABLE ROW LEVEL SECURITY;

-- ---------- 3. 邀请码（想改注册邀请码，改这里即可） ----------
CREATE OR REPLACE FUNCTION public.app_invite_code()
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '0123'::text
$$;

-- ---------- 4. RPC 函数（SECURITY DEFINER，函数内部校验，前端只调函数） ----------

-- 注册
CREATE OR REPLACE FUNCTION public.register(p_username text, p_password text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u_id int;
BEGIN
  IF p_username IS NULL OR p_username = '' OR p_password IS NULL OR p_password = '' THEN
    RETURN jsonb_build_object('success', false, 'msg', '用户名/密码不能为空');
  END IF;
  IF p_code IS NULL OR p_code <> public.app_invite_code() THEN
    RETURN jsonb_build_object('success', false, 'msg', '注册码错误');
  END IF;
  SELECT id INTO u_id FROM public.users WHERE username = p_username;
  IF u_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'msg', '用户名已存在');
  END IF;
  INSERT INTO public.users(username, password) VALUES (p_username, p_password);
  RETURN jsonb_build_object('success', true, 'msg', 'ok');
END $$;

-- 登录
CREATE OR REPLACE FUNCTION public.login(p_username text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  u_id int;
  u_username text;
  u_avatar text;
BEGIN
  SELECT id, username, avatar INTO u_id, u_username, u_avatar
  FROM public.users WHERE username = p_username AND password = p_password LIMIT 1;
  IF u_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'msg', '用户名或密码错误');
  END IF;
  RETURN jsonb_build_object('success', true, 'msg', 'ok',
    'user', jsonb_build_object('id', u_id, 'username', u_username, 'avatar', COALESCE(u_avatar, '')));
END $$;

-- 好友列表
CREATE OR REPLACE FUNCTION public.get_friends(p_username text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_agg(x) INTO result FROM (
    SELECT f.remark, u.username AS friend, u.avatar
    FROM public.friends f
    JOIN public.users u ON f.friend_id = u.id
    WHERE f.user_id = (SELECT id FROM public.users WHERE username = p_username)
    ORDER BY f.id
  ) x;
  RETURN COALESCE(result, '[]'::jsonb);
END $$;

-- 会话列表（每个好友最后一条消息）
CREATE OR REPLACE FUNCTION public.get_conversations(p_username text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_agg(x) INTO result FROM (
    SELECT DISTINCT ON (f.friend_id)
      f.friend_id, f.remark, u.username AS friend, u.avatar,
      m.id AS msg_id, m.message, m.type, m.ts, m.from_user
    FROM public.friends f
    JOIN public.users u ON u.id = f.friend_id
    LEFT JOIN public.messages m ON (m.from_user = p_username AND m.to_user = u.username)
                               OR (m.to_user = p_username AND m.from_user = u.username)
    WHERE f.user_id = (SELECT id FROM public.users WHERE username = p_username)
    ORDER BY f.friend_id, m.id DESC NULLS LAST
  ) x;
  RETURN COALESCE(result, '[]'::jsonb);
END $$;

-- 聊天历史（分页：limit 默认 200，before 传消息 id 取更早的）
CREATE OR REPLACE FUNCTION public.get_messages(
  p_user text, p_friend text,
  p_limit integer DEFAULT 200, p_before bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lim integer := LEAST(COALESCE(p_limit, 200), 500);
  result jsonb;
BEGIN
  SELECT jsonb_agg(x) INTO result FROM (
    SELECT * FROM (
      SELECT * FROM public.messages
      WHERE ((from_user = p_user AND to_user = p_friend) OR (from_user = p_friend AND to_user = p_user))
        AND (p_before IS NULL OR id < p_before)
      ORDER BY id DESC LIMIT lim
    ) sub ORDER BY id ASC
  ) x;
  RETURN COALESCE(result, '[]'::jsonb);
END $$;

-- 发消息（写库 + 未读数原子 +1，返回新消息 id / ts）
CREATE OR REPLACE FUNCTION public.send_message(
  p_from text, p_to text, p_message text,
  p_type text DEFAULT 'text', p_ts bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id bigint;
  msg_ts bigint := COALESCE(p_ts, (EXTRACT(EPOCH FROM now())*1000)::bigint);
  from_id int;
  to_id int;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_message IS NULL OR p_message = '' THEN
    RETURN jsonb_build_object('success', false, 'msg', '参数错误');
  END IF;
  INSERT INTO public.messages(from_user, to_user, message, type, ts)
  VALUES (p_from, p_to, p_message, COALESCE(p_type, 'text'), msg_ts)
  RETURNING id INTO new_id;

  SELECT id INTO from_id FROM public.users WHERE username = p_from;
  SELECT id INTO to_id   FROM public.users WHERE username = p_to;
  IF from_id IS NOT NULL AND to_id IS NOT NULL THEN
    INSERT INTO public.unread_counts(user_id, from_user_id, count)
    VALUES (to_id, from_id, 1)
    ON CONFLICT (user_id, from_user_id) DO UPDATE SET count = public.unread_counts.count + 1;
  END IF;

  RETURN jsonb_build_object('success', true, 'msg', 'ok', 'id', new_id, 'ts', msg_ts);
END $$;

-- 打开会话：未读清零
CREATE OR REPLACE FUNCTION public.open_conversation(p_user text, p_friend text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.unread_counts uc
  SET count = 0
  FROM public.users u, public.users f
  WHERE uc.user_id = u.id AND uc.from_user_id = f.id
    AND u.username = p_user AND f.username = p_friend;
  RETURN jsonb_build_object('success', true);
END $$;

-- 未读计数列表
CREATE OR REPLACE FUNCTION public.get_unread_counts(p_username text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_agg(x) INTO result FROM (
    SELECT u.username AS from_user, c.count
    FROM public.unread_counts c
    JOIN public.users u ON c.from_user_id = u.id
    WHERE c.user_id = (SELECT id FROM public.users WHERE username = p_username)
  ) x;
  RETURN COALESCE(result, '[]'::jsonb);
END $$;

-- 添加好友（双向）
CREATE OR REPLACE FUNCTION public.add_friend(p_user text, p_friend text, p_remark text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid int; fid int;
BEGIN
  IF p_user IS NULL OR p_friend IS NULL OR p_user = '' OR p_friend = '' THEN
    RETURN jsonb_build_object('success', false, 'msg', '用户名和好友不能为空');
  END IF;
  IF p_user = p_friend THEN
    RETURN jsonb_build_object('success', false, 'msg', '不能添加自己为好友');
  END IF;
  SELECT id INTO uid FROM public.users WHERE username = p_user;
  SELECT id INTO fid FROM public.users WHERE username = p_friend;
  IF uid IS NULL OR fid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'msg', '用户不存在');
  END IF;
  INSERT INTO public.friends(user_id, friend_id, remark) VALUES (uid, fid, COALESCE(p_remark, ''))
  ON CONFLICT (user_id, friend_id) DO UPDATE SET remark = EXCLUDED.remark;
  INSERT INTO public.friends(user_id, friend_id, remark) VALUES (fid, uid, '')
  ON CONFLICT (user_id, friend_id) DO NOTHING;
  RETURN jsonb_build_object('success', true, 'msg', 'ok');
END $$;

-- 设置备注
CREATE OR REPLACE FUNCTION public.set_remark(p_owner text, p_friend text, p_remark text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.friends f
  SET remark = p_remark
  FROM public.users o, public.users fr
  WHERE f.user_id = o.id AND f.friend_id = fr.id
    AND o.username = p_owner AND fr.username = p_friend;
  RETURN jsonb_build_object('success', true);
END $$;

-- 更新头像
CREATE OR REPLACE FUNCTION public.update_profile(p_username text, p_avatar text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.users SET avatar = COALESCE(p_avatar, '') WHERE username = p_username;
  RETURN jsonb_build_object('success', true);
END $$;

-- ---------- 5. 授权：只允许调用函数，不允许直接碰表 ----------
REVOKE ALL ON FUNCTION public.app_invite_code()          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register(text,text,text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.login(text,text)           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_friends(text)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_conversations(text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_messages(text,text,integer,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_message(text,text,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_conversation(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_unread_counts(text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_friend(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_remark(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_profile(text,text)  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.app_invite_code()          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register(text,text,text)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login(text,text)           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_friends(text)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_conversations(text)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_messages(text,text,integer,bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_message(text,text,text,text,bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_conversation(text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unread_counts(text)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_friend(text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_remark(text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_profile(text,text)  TO anon, authenticated;

-- ---------- 6. Storage：聊天图片/头像桶（公开读；匿名上传与旧 /upload 同级信任） ----------
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-images', 'chat-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "anon_upload_chat_images" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'chat-images');
CREATE POLICY "anon_select_chat_images" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'chat-images');
CREATE POLICY "anon_update_chat_images" ON storage.objects
  FOR UPDATE TO anon USING (bucket_id = 'chat-images');
CREATE POLICY "anon_delete_chat_images" ON storage.objects
  FOR DELETE TO anon USING (bucket_id = 'chat-images');
