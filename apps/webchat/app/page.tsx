'use client';

import './widget.css';

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore';
import { ensureAnonAuth, getFirebaseFirestore } from '@/lib/firebase';

interface Mensagem {
  id?: string;
  mid?: string;
  conteudo: string;
  user_id: string | null;
  estadoEnvio: number;
  tipo: 'c';
  canal: number;
  // millisecondsSinceEpoch INT wire format (#484/#486).
  timestamp: number;
  _localId?: string;
}

const ESTADO = { salva: 1, enviando: 2, enviado: 3, erro: 4 } as const;

/**
 * Embeddable chat widget. Mounts at the static-export `/` route. The
 * loader script (public/loader.js) injects an <iframe> pointing here.
 * The Firebase project itself is the tenant boundary for now;
 * per-tenant routing in the URL query is reserved for the multi-project
 * setup we ship later.
 */
export default function WebchatPage() {
  const [uid, setUid] = useState<string | null>(null);
  const [conversaId, setConversaId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Mensagem[]>([]);
  const [pending, setPending] = useState<Mensagem[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Boot: anonymous auth + create-or-resume Conversa keyed by uid.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const userId = await ensureAnonAuth();
        if (cancelled) return;
        setUid(userId);
        const db = getFirebaseFirestore();
        const conversaRef = doc(db, `chat/${userId}`);
        await setDoc(
          conversaRef,
          {
            usarioOuterRef: `documents/users/${userId}`,
            usuarios: [userId],
            estadoConversa: 0,
            origem: 'site',
            atendido: false,
            nome: 'Visitante do site',
            urlAvatar: '',
            data_cadastro: Date.now(),
            ultima_modificacao: Date.now(),
            versao: 1,
          },
          { merge: true },
        );
        setConversaId(userId);
      } catch (err) {
        if (err instanceof FirebaseError) {
          if (!cancelled) setError(err.message);
        } else {
          throw err;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!conversaId) return;
    const db = getFirebaseFirestore();
    const q = query(
      collection(db, `chat/${conversaId}/mensagem`),
      orderBy('timestamp', 'desc'),
      limit(200),
    );
    return onSnapshot(
      q,
      (snap) => {
        const docs = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Mensagem, 'id'>),
        }));
        docs.reverse();
        setMessages(docs);
      },
      (err) => setError(err.message),
    );
  }, [conversaId]);

  const merged = useMemo(() => {
    const seenMids = new Set(messages.map((m) => m.mid).filter((v): v is string => Boolean(v)));
    return [...messages, ...pending.filter((p) => !p.mid || !seenMids.has(p.mid))];
  }, [messages, pending]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [merged.length]);

  const handleSend = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text || !conversaId || !uid) return;
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      setPending((p) => [
        ...p,
        {
          conteudo: text,
          user_id: uid,
          estadoEnvio: ESTADO.enviando,
          tipo: 'c',
          canal: 0,
          timestamp: now,
          mid: localId,
          _localId: localId,
        },
      ]);
      setDraft('');
      try {
        await addDoc(collection(getFirebaseFirestore(), `chat/${conversaId}/mensagem`), {
          conteudo: text,
          user_id: uid,
          estadoEnvio: ESTADO.salva,
          tipo: 'c',
          canal: 0,
          timestamp: now,
          mid: localId,
          createdAt: Timestamp.now(),
        });
        await setDoc(
          doc(getFirebaseFirestore(), `chat/${conversaId}`),
          { ultima_modificacao: now },
          { merge: true },
        );
      } catch (err) {
        if (err instanceof FirebaseError) {
          setPending((p) =>
            p.map((m) => (m._localId === localId ? { ...m, estadoEnvio: ESTADO.erro } : m)),
          );
          setError(err.message);
        } else {
          throw err;
        }
      }
    },
    [draft, conversaId, uid],
  );

  return (
    <main className="widget">
      <header>
        <strong>Atendimento</strong>
        <small>{uid ? '🟢 conectado' : 'conectando…'}</small>
      </header>

      {error && <div className="error">{error}</div>}

      <div ref={scrollRef} className="thread" role="log">
        {merged.length === 0 && uid && <p className="empty">Como podemos ajudar?</p>}
        {merged.map((m, i) => {
          const own = m.user_id === uid;
          return (
            <div
              key={m.id ?? m._localId ?? `${i}-${m.timestamp}`}
              className={`bubble ${own ? 'own' : 'them'}`}
            >
              <span>{m.conteudo}</span>
              <time>
                {new Date(m.timestamp).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {own && m.estadoEnvio === ESTADO.erro && ' · erro'}
                {own && m.estadoEnvio === ESTADO.enviando && ' · enviando'}
              </time>
            </div>
          );
        })}
      </div>

      <form className="composer" onSubmit={handleSend}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Digite sua mensagem…"
          aria-label="Mensagem"
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim() || !conversaId}>
          ➤
        </button>
      </form>
    </main>
  );
}
