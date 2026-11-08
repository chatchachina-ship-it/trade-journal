//+------------------------------------------------------------------+
//| TradeJournalSync.mq5                                             |
//| Отправляет позиции счёта в «Дневник сделок» в зашифрованном виде.|
//|                                                                  |
//| ТОЛЬКО ЧТЕНИЕ. Робот не открывает, не закрывает и не изменяет    |
//| сделки и ордера: в коде нет ни одной торговой функции            |
//| (OrderSend, PositionClose, CTrade и т.п.).                       |
//|                                                                  |
//| Что уходит в сеть: только шифр (AES-256-CTR + HMAC-SHA256),      |
//| ключ никуда не отправляется. У робота свой ключ (tjr_): он        |
//| открывает только позиции MT5, но не заметки и ручные сделки.     |
//| Схема та же, что в web/crypto.js; при запуске робот сверяет себя |
//| с эталоном и без совпадения ничего не отправляет.                |
//|                                                                  |
//| Для гарантии на уровне терминала: в свойствах робота снимите     |
//| «Разрешить алгоритмическую торговлю» — роботу она не нужна.      |
//+------------------------------------------------------------------+
#property copyright   "Дневник сделок"
#property version     "1.10"
#property description "Отправляет открытые и закрытые позиции в Дневник сделок (зашифровано)."
#property description "Только чтение: не открывает, не закрывает и не изменяет сделки."

#include <Generic\HashMap.mqh>

input string InpUrl   = "";   // Адрес базы (https://xxxx.supabase.co)
input string InpAnon  = "";   // Публичный ключ (anon / publishable)
input string InpToken = "";   // Токен синхронизации (tjs_...)
input string InpKey   = "";   // Ключ робота (tjr_...)
input int    InpDays  = 365;  // Отправить историю за N дней при запуске
input int    InpEvery = 300;  // Отправлять изменения раз в N секунд (не чаще 60)

uchar  g_enc[], g_mac[], g_rid[], g_nonce[];
string g_url, g_headers, g_account, g_status = "";
bool   g_full = true, g_busy = false, g_first = true;
long   g_tzShift = 0;
int    g_sentTotal = 0;
CHashMap<string, string> g_sent;  // rid -> отправленный открытый текст (чтобы не слать одно и то же)

//+------------------------------------------------------------------+
//| байты и криптография                                             |
//+------------------------------------------------------------------+
void Utf8(const string s, uchar &out[])
  {
   ArrayResize(out, 0);
   if(StringLen(s) == 0)
      return;
   int n = StringToCharArray(s, out, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0 && out[n - 1] == 0)
      ArrayResize(out, n - 1);
  }

void Append(uchar &dst[], const uchar &src[])
  {
   int n = ArraySize(dst), m = ArraySize(src);
   ArrayResize(dst, n + m);
   if(m > 0)
      ArrayCopy(dst, src, n, 0, m);
  }

string Hex(const uchar &b[], int count)
  {
   string s = "";
   for(int i = 0; i < count; i++)
      s += StringFormat("%02x", b[i]);
   return s;
  }

bool Sha256(const uchar &data[], uchar &out[])
  {
   uchar nokey[];
   return CryptEncode(CRYPT_HASH_SHA256, data, nokey, out) == 32;
  }

// HMAC-SHA256 по RFC 2104 (в MQL5 нет готового).
bool Hmac(const uchar &key[], const uchar &msg[], uchar &out[])
  {
   uchar k[];
   ArrayResize(k, 64);
   ArrayInitialize(k, 0);
   if(ArraySize(key) > 64)
     {
      uchar h[];
      if(!Sha256(key, h))
         return false;
      ArrayCopy(k, h, 0, 0, 32);
     }
   else
      if(ArraySize(key) > 0)
         ArrayCopy(k, key, 0, 0, ArraySize(key));
   uchar inner[], outer[], ih[];
   ArrayResize(inner, 64);
   ArrayResize(outer, 64);
   for(int i = 0; i < 64; i++)
     {
      inner[i] = (uchar)(k[i] ^ 0x36);
      outer[i] = (uchar)(k[i] ^ 0x5C);
     }
   Append(inner, msg);
   if(!Sha256(inner, ih))
      return false;
   Append(outer, ih);
   return Sha256(outer, out);
  }

bool HmacLabel(const uchar &key[], const string label, uchar &out[])
  {
   uchar m[];
   Utf8(label, m);
   return Hmac(key, m, out);
  }

// Один блок AES-256 (ключевой поток для режима CTR).
bool AesBlock(const uchar &key[], const uchar &block[], uchar &out[])
  {
   uchar res[];
   if(CryptEncode(CRYPT_AES256, block, key, res) < 16)
      return false;
   ArrayResize(out, 16);
   ArrayCopy(out, res, 0, 0, 16);
   return true;
  }

bool HexToBytes(const string s, uchar &out[])
  {
   int n = StringLen(s);
   if(n % 2 != 0)
      return false;
   ArrayResize(out, n / 2);
   for(int i = 0; i < n / 2; i++)
     {
      int v = 0;
      for(int j = 0; j < 2; j++)
        {
         ushort c = StringGetCharacter(s, i * 2 + j);
         int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1;
         if(d < 0)
            return false;
         v = v * 16 + d;
        }
      out[i] = (uchar)v;
     }
   return true;
  }

bool DeriveKeys(const string keyString)
  {
   string k = keyString;
   StringTrimLeft(k);
   StringTrimRight(k);
   StringToLower(k);
   if(StringLen(k) != 68 || StringSubstr(k, 0, 4) != "tjr_")   // только ключ робота, не ключ пользователя
      return false;
   uchar master[];
   if(!HexToBytes(StringSubstr(k, 4), master))
      return false;
   return HmacLabel(master, "tj-enc", g_enc) && HmacLabel(master, "tj-mac", g_mac)
          && HmacLabel(master, "tj-rid", g_rid) && HmacLabel(master, "tj-nonce", g_nonce);
  }

string Rid(const string label)
  {
   uchar h[];
   if(!HmacLabel(g_rid, label, h))
      return "";
   return Hex(h, 16);
  }

// base64(nonce || шифр || подпись).
// Текст дополняется пробелами до кратного 256 байт; nonce = HMAC(nonce-ключ, текст)[0..12] + 4 байта счётчика.
string Encrypt(const string rid, const string json)
  {
   uchar pt[], nh[], nonce[], ct[], ctr[], ks[];
   Utf8(json, pt);
   int raw = ArraySize(pt);
   int len = ((raw + 255) / 256) * 256;
   ArrayResize(pt, len);
   for(int i = raw; i < len; i++)
      pt[i] = ' ';
   if(!Hmac(g_nonce, pt, nh))
      return "";
   ArrayResize(nonce, 16);
   ArrayInitialize(nonce, 0);
   ArrayCopy(nonce, nh, 0, 0, 12);
   ArrayResize(ct, len);
   ArrayResize(ctr, 16);
   uint block = 0;
   for(int off = 0; off < len; off += 16)
     {
      ArrayCopy(ctr, nonce, 0, 0, 12);
      for(int i = 0; i < 4; i++)
         ctr[15 - i] = (uchar)((block >> (8 * i)) & 0xFF);
      if(!AesBlock(g_enc, ctr, ks))
         return "";
      for(int i = 0; i < 16 && off + i < len; i++)
         ct[off + i] = (uchar)(pt[off + i] ^ ks[i]);
      block++;
     }
   uchar macIn[], zero[], tag[], all[], b64[], nokey[];
   Utf8(rid, macIn);
   ArrayResize(zero, 1);
   zero[0] = 0;
   Append(macIn, zero);
   Append(macIn, nonce);
   Append(macIn, ct);
   if(!Hmac(g_mac, macIn, tag))
      return "";
   Append(all, nonce);
   Append(all, ct);
   Append(all, tag);
   if(CryptEncode(CRYPT_BASE64, all, nokey, b64) <= 0)
      return "";
   string s = CharArrayToString(b64, 0, ArraySize(b64), CP_ACP);
   StringReplace(s, "\r", "");
   StringReplace(s, "\n", "");
   return s;
  }

// Сверка с официальными векторами и с эталоном web/crypto.js. Без неё робот не запустится.
bool SelfTest()
  {
   uchar key[], block[], out[];
   ArrayResize(key, 32);
   for(int i = 0; i < 32; i++)
      key[i] = (uchar)i;
   HexToBytes("00112233445566778899aabbccddeeff", block);
   if(!AesBlock(key, block, out) || Hex(out, 16) != "8ea2b7ca516745bfeafc49904b496089")
     { Print("Самопроверка AES-256 не пройдена"); return false; }

   uchar hk[], hm[], hout[];
   Utf8("Jefe", hk);
   Utf8("what do ya want for nothing?", hm);
   if(!Hmac(hk, hm, hout) || Hex(hout, 32) != "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
     { Print("Самопроверка HMAC-SHA256 не пройдена"); return false; }

   // Эталон из tests/crypto_reference.py (тот же, что проверяет web/crypto.js).
   if(!DeriveKeys("tjr_992c33a2503ba016ef4495c6b1b8ec309b0b27a2e2b58b11a2c895b68566b3d0"))
     { Print("Самопроверка ключа не пройдена"); return false; }
   string r = Rid("mt5:12345678:987654321");
   string c = Encrypt(r, "{\"t\":\"mt5\",\"account\":\"12345678\",\"pos\":987654321,\"symbol\":\"XAUUSD\",\"isLong\":true,\"entry\":2650.15,\"exit\":2661.4,\"stop\":2640,\"qty\":0.1,\"profit\":112.5,\"riskMoney\":101.5,\"date\":\"2026-11-03T10:15:20Z\",\"closeDate\":\"2026-11-03T12:01:00Z\",\"open\":false}");
   if(r != "e9cfab0f7c40e7c61f623e6842a5e7eb"
      || c != "CRdjwXMLmdHSSnVQAAAAAI6uIj4XDF61zGxKggNmls4MC8KZmeqSd7mK9WdeueEtaNabp1dk+dUzrNb1LcS2sSQ02W4JX/hezyOsAYy1HMlSZIubg9ULxRVC4epXFkjXWorjKxZ6OyF4YAGMQ6IhlIB5lX4AG6JA0DOjmQSG6XEEcYVlUgrNmaF2aXf5UbzvhcKdgbpQQ2tVZtMLH6OhTkMFd3VmpRsRvBbu58tyRej9Zh1BpXqAfxCPoTeVG/A/gBjZtJJakCU7cSme51dPcPbm97wHGDFRQCXAXc3ONkWxYD2JH7xMaI0YbkxXycvbBV+AT3tB5XMFddRJcmZVJVXYqkHdrF+CNmi4pvPW55iGDkRycPwXZsiwZVQep28EC9Da1acIo+CfTTqmwhfVGA==")
     {
      Print("Самопроверка шифрования не совпала с приложением. Отправка отключена.");
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| JSON                                                             |
//+------------------------------------------------------------------+
string JStr(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\t", " ");
   return "\"" + s + "\"";
  }

string JNum(double v)
  {
   if(!MathIsValidNumber(v))
      return "null";
   string s = DoubleToString(v, 8);
   while(StringLen(s) > 1 && StringSubstr(s, StringLen(s) - 1) == "0")
      s = StringSubstr(s, 0, StringLen(s) - 1);
   if(StringSubstr(s, StringLen(s) - 1) == ".")
      s = StringSubstr(s, 0, StringLen(s) - 1);
   if(s == "-0")
      s = "0";
   return s;
  }

// Время сервера брокера → UTC.
string JTime(datetime serverTime)
  {
   MqlDateTime t;
   TimeToStruct((datetime)((long)serverTime - g_tzShift), t);
   return StringFormat("\"%04d-%02d-%02dT%02d:%02d:%02dZ\"", t.year, t.mon, t.day, t.hour, t.min, t.sec);
  }

//+------------------------------------------------------------------+
//| сбор позиций (только чтение истории и открытых позиций)          |
//+------------------------------------------------------------------+
struct PosInfo
  {
   ulong    id;
   string   symbol;
   bool     isLong;
   double   inVol, inVal, outVol, outVal, profit, sl;
   datetime openT, closeT;
  };

void InitPos(PosInfo &p, ulong id, string symbol, bool isLong, datetime t)
  {
   p.id = id; p.symbol = symbol; p.isLong = isLong;
   p.inVol = 0; p.inVal = 0; p.outVol = 0; p.outVal = 0; p.profit = 0; p.sl = 0;
   p.openT = t; p.closeT = 0;
  }

double RiskMoney(const string symbol, bool isLong, double volume, double entry, double sl)
  {
   if(sl <= 0 || volume <= 0 || (isLong && sl >= entry) || (!isLong && sl <= entry))
      return 0;
   double p = 0;
   // Расчёт денег на стопе по спецификации контракта. Это калькулятор, а не торговая операция.
   if(!OrderCalcProfit(isLong ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, symbol, volume, entry, sl, p))
      return 0;
   return MathAbs(p);
  }

string PosJson(ulong id, string symbol, bool isLong, double entry, double exitPrice, double sl, double qty,
               double profit, double risk, datetime openT, datetime closeT, bool open)
  {
   return "{\"t\":\"mt5\",\"account\":" + JStr(g_account)
          + ",\"pos\":" + IntegerToString((long)id)
          + ",\"symbol\":" + JStr(symbol)
          + ",\"isLong\":" + (isLong ? "true" : "false")
          + ",\"entry\":" + JNum(entry)
          + ",\"exit\":" + (open ? "null" : JNum(exitPrice))
          + ",\"stop\":" + (sl > 0 ? JNum(sl) : "null")
          + ",\"qty\":" + JNum(qty)
          + ",\"profit\":" + (open ? "null" : JNum(profit))
          + ",\"riskMoney\":" + (risk > 0 ? JNum(risk) : "null")
          + ",\"date\":" + JTime(openT)
          + ",\"closeDate\":" + (open ? "null" : JTime(closeT))
          + ",\"open\":" + (open ? "true" : "false") + "}";
  }

int Collect(datetime from, string &labels[], string &jsons[])
  {
   ArrayResize(labels, 0);
   ArrayResize(jsons, 0);
   CHashMap<ulong, int> openIds;

   // открытые позиции
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      ulong  id     = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
      string symbol = PositionGetString(POSITION_SYMBOL);
      bool   isLong = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double entry  = PositionGetDouble(POSITION_PRICE_OPEN);
      double vol    = PositionGetDouble(POSITION_VOLUME);
      double sl     = PositionGetDouble(POSITION_SL);
      int n = ArraySize(labels);
      ArrayResize(labels, n + 1);
      ArrayResize(jsons, n + 1);
      labels[n] = "mt5:" + g_account + ":" + IntegerToString((long)id);
      jsons[n]  = PosJson(id, symbol, isLong, entry, 0, sl, vol, 0, RiskMoney(symbol, isLong, vol, entry, sl),
                          (datetime)PositionGetInteger(POSITION_TIME), 0, true);
      openIds.Add(id, n);
     }

   // закрытые позиции из истории сделок
   if(!HistorySelect(from, TimeCurrent() + 86400))
      return ArraySize(labels);
   PosInfo list[];
   CHashMap<ulong, int> idx;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0)
         continue;
      long type = HistoryDealGetInteger(d, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL)
         continue;
      ulong pid = (ulong)HistoryDealGetInteger(d, DEAL_POSITION_ID);
      if(openIds.ContainsKey(pid))
         continue;
      long     entryType = HistoryDealGetInteger(d, DEAL_ENTRY);
      double   vol   = HistoryDealGetDouble(d, DEAL_VOLUME);
      double   price = HistoryDealGetDouble(d, DEAL_PRICE);
      datetime t     = (datetime)HistoryDealGetInteger(d, DEAL_TIME);
      int k;
      if(!idx.TryGetValue(pid, k))
        {
         k = ArraySize(list);
         ArrayResize(list, k + 1);
         InitPos(list[k], pid, HistoryDealGetString(d, DEAL_SYMBOL), type == DEAL_TYPE_BUY, t);
         idx.Add(pid, k);
        }
      list[k].profit += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_COMMISSION)
                        + HistoryDealGetDouble(d, DEAL_SWAP) + HistoryDealGetDouble(d, DEAL_FEE);
      if(entryType == DEAL_ENTRY_IN)
        {
         if(list[k].inVol == 0)
           {
            list[k].isLong = type == DEAL_TYPE_BUY;
            list[k].openT  = t;
            list[k].sl     = HistoryDealGetDouble(d, DEAL_SL);
           }
         list[k].inVol += vol;
         list[k].inVal += vol * price;
        }
      else
         if(entryType == DEAL_ENTRY_OUT || entryType == DEAL_ENTRY_OUT_BY || entryType == DEAL_ENTRY_INOUT)
           {
            list[k].outVol += vol;
            list[k].outVal += vol * price;
            list[k].closeT  = t;
            if(list[k].sl <= 0)
               list[k].sl = HistoryDealGetDouble(d, DEAL_SL);
           }
     }

   for(int k = 0; k < ArraySize(list); k++)
     {
      if(list[k].inVol <= 0 || list[k].outVol <= 0)
         continue;  // вход раньше окна истории или позиция ещё не закрыта
      double entry = list[k].inVal / list[k].inVol;
      double exitP = list[k].outVal / list[k].outVol;
      int n = ArraySize(labels);
      ArrayResize(labels, n + 1);
      ArrayResize(jsons, n + 1);
      labels[n] = "mt5:" + g_account + ":" + IntegerToString((long)list[k].id);
      jsons[n]  = PosJson(list[k].id, list[k].symbol, list[k].isLong, entry, exitP, list[k].sl, list[k].inVol,
                          list[k].profit, RiskMoney(list[k].symbol, list[k].isLong, list[k].inVol, entry, list[k].sl),
                          list[k].openT, list[k].closeT, false);
     }
   return ArraySize(labels);
  }

//+------------------------------------------------------------------+
//| отправка                                                          |
//+------------------------------------------------------------------+
bool SendBatch(string &rids[], string &cts[], int from, int count)
  {
   string body = "{\"p_token\":" + JStr(InpToken) + ",\"p_items\":[";
   for(int i = 0; i < count; i++)
      body += (i > 0 ? "," : "") + "{\"rid\":\"" + rids[from + i] + "\",\"ct\":\"" + cts[from + i] + "\"}";
   body += "]}";
   uchar data[], result[];
   Utf8(body, data);
   string resHeaders;
   ResetLastError();
   int code = WebRequest("POST", g_url + "/rest/v1/rpc/ingest", g_headers, 15000, data, result, resHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      if(err == 4014)
         g_status = "Разреши адрес в Сервис → Настройки → Советники → WebRequest: " + g_url;
      else
         g_status = "Нет связи с сервером (ошибка " + IntegerToString(err) + ")";
      Print(g_status);
      return false;
     }
   if(code != 200)
     {
      string answer = CharArrayToString(result, 0, MathMin(ArraySize(result), 300), CP_UTF8);
      g_status = "Сервер ответил " + IntegerToString(code) + (code == 400 && StringFind(answer, "токен") >= 0 ? ": неверный или отозванный токен" : "");
      Print(g_status, " ", answer);
      return false;
     }
   return true;
  }

void Sync()
  {
   if(g_busy)
      return;
   g_busy = true;
   g_tzShift = (((long)(TimeTradeServer() - TimeGMT()) + 450) / 900) * 900;
   datetime from = (datetime)((long)TimeCurrent() - (g_full ? (long)InpDays : 3) * 86400);

   string labels[], jsons[];
   int n = Collect(from, labels, jsons);
   string rids[], cts[], plain[];
   int m = 0;
   for(int i = 0; i < n; i++)
     {
      string rid = Rid(labels[i]);
      string prev;
      if(rid == "" || (g_sent.TryGetValue(rid, prev) && prev == jsons[i]))
         continue;
      string ct = Encrypt(rid, jsons[i]);
      if(ct == "")
         continue;
      ArrayResize(rids, m + 1);
      ArrayResize(cts, m + 1);
      ArrayResize(plain, m + 1);
      rids[m] = rid;
      cts[m] = ct;
      plain[m] = jsons[i];
      m++;
     }

   bool ok = true;
   for(int i = 0; i < m && ok; i += 100)
     {
      int count = MathMin(100, m - i);
      ok = SendBatch(rids, cts, i, count);
      if(ok)
         for(int j = i; j < i + count; j++)
           {
            g_sent.TrySetValue(rids[j], plain[j]);
            g_sentTotal++;
           }
     }
   if(ok)
     {
      g_full = false;
      g_status = "Синхронизировано " + TimeToString(TimeLocal(), TIME_MINUTES) + ", отправлено всего: " + IntegerToString(g_sentTotal);
     }
   Comment("Дневник сделок: ", g_status);
   g_busy = false;
  }

//+------------------------------------------------------------------+
//| события                                                           |
//+------------------------------------------------------------------+
// Адрес вида https://<проект>.supabase.co — других адресов робот не принимает.
bool ValidUrl(const string url)
  {
   string pre = "https://", post = ".supabase.co";
   int n = StringLen(url), a = StringLen(pre), b = StringLen(post);
   if(n <= a + b || StringSubstr(url, 0, a) != pre || StringSubstr(url, n - b) != post)
      return false;
   for(int i = a; i < n - b; i++)
     {
      ushort c = StringGetCharacter(url, i);
      if(!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
         return false;
     }
   return true;
  }

// Секретный ключ (service_role) обходит все правила доступа — с ним робот работать не будет.
bool IsSecretKey(const string key)
  {
   if(StringFind(key, "sb_secret_") == 0)
      return true;
   string parts[];
   if(StringSplit(key, '.', parts) != 3)
      return false;
   string p = parts[1];
   StringReplace(p, "-", "+");
   StringReplace(p, "_", "/");
   while(StringLen(p) % 4 != 0)
      p += "=";
   uchar src[], out[], nokey[];
   StringToCharArray(p, src, 0, StringLen(p), CP_ACP);
   if(CryptDecode(CRYPT_BASE64, src, nokey, out) <= 0)
      return false;
   return StringFind(CharArrayToString(out, 0, ArraySize(out), CP_UTF8), "service_role") >= 0;
  }

int OnInit()
  {
   g_url = InpUrl;
   StringTrimLeft(g_url);
   StringTrimRight(g_url);
   StringToLower(g_url);
   while(StringLen(g_url) > 0 && StringSubstr(g_url, StringLen(g_url) - 1) == "/")
      g_url = StringSubstr(g_url, 0, StringLen(g_url) - 1);
   if(!ValidUrl(g_url))
     { Alert("Дневник сделок: адрес базы должен быть вида https://xxxx.supabase.co"); return INIT_PARAMETERS_INCORRECT; }
   if(StringLen(InpAnon) < 20)
     { Alert("Дневник сделок: не указан публичный ключ"); return INIT_PARAMETERS_INCORRECT; }
   if(IsSecretKey(InpAnon))
     { Alert("Дневник сделок: это секретный ключ service_role! Нужен публичный (anon / publishable)"); return INIT_PARAMETERS_INCORRECT; }
   uchar tokBytes[];
   if(StringLen(InpToken) != 68 || StringSubstr(InpToken, 0, 4) != "tjs_" || !HexToBytes(StringSubstr(InpToken, 4), tokBytes))
     { Alert("Дневник сделок: неверный токен (должен начинаться с tjs_)"); return INIT_PARAMETERS_INCORRECT; }

   if(!SelfTest())
     { Alert("Дневник сделок: самопроверка шифрования не пройдена, робот остановлен"); return INIT_FAILED; }
   if(!DeriveKeys(InpKey))
     { Alert("Дневник сделок: неверный ключ робота (должен начинаться с tjr_)"); return INIT_PARAMETERS_INCORRECT; }

   // Новые ключи Supabase (sb_publishable_...) передаются только в apikey, старые (JWT) — ещё и как Bearer.
   g_headers = "Content-Type: application/json\r\napikey: " + InpAnon + "\r\n";
   if(StringSubstr(InpAnon, 0, 3) == "eyJ")
      g_headers += "Authorization: Bearer " + InpAnon + "\r\n";

   g_account = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   g_full = true;
   g_first = true;
   EventSetTimer(2);  // первая синхронизация через 2 секунды, дальше — раз в InpEvery секунд
   Print("Дневник сделок: робот запущен для счёта ", g_account, ". Только чтение — торговых действий нет.");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

void OnTimer()
  {
   if(g_first)
     {
      g_first = false;
      EventKillTimer();
      // Отправка по таймеру, а не в момент сделки: сервер не видит точного времени входов и выходов.
      EventSetTimer(MathMax(60, InpEvery));
     }
   Sync();
  }
//+------------------------------------------------------------------+
