// 必要なライブラリを読み込む
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { Client } = require('@notionhq/client');
const OpenAI = require('openai');
const cron = require('node-cron');
require('dotenv').config();

// 各サービスの初期設定
const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LINE設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const lineClient = new line.Client(lineConfig);

// Shopify設定
const shopifyAxios = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

// テンプレートキャッシュ
let responseTemplates = null;
let templateLastUpdated = null;

// =====================================
// LINEメッセージ受信部分
// =====================================
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: 'success' });
  } catch (err) {
    console.error('エラー発生:', err);
    res.status(500).end();
  }
});

// メッセージを処理する関数
async function handleEvent(event) {
  // メッセージイベント以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const userMessage = event.message.text;
  
  console.log(`受信: ${userMessage}`);
  
  // ユーザー情報を取得
  let userName = '顧客';
  try {
    const profile = await lineClient.getProfile(userId);
    userName = profile.displayName;
  } catch (error) {
    console.log('プロフィール取得エラー:', error);
  }
  
  // メッセージを分析してコンテキストを準備（userIdを追加）
  const context = await analyzeMessage(userMessage, userId);
  context.userId = userId; // userIdをcontextに追加
  
  // ChatGPTで返答を生成
  let replyMessage = await generateAIResponse(userMessage, context);
  
  // Notionに会話を記録（エラーハンドリング改善）
  try {
    await saveToNotion({
      userId: userId,
      userName: userName,
      userMessage: userMessage,
      aiReply: replyMessage,
      orderNumber: context.orderNumber,
      status: context.requiresHumanReview ? '要確認' : '対応済み',
      category: context.category
    });
  } catch (notionError) {
    console.error('Notion保存エラー（続行）:', notionError.message);
    // Notionエラーでも返信は続行
  }
  
  // LINEに返信
  return lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: replyMessage
  });
}

// =====================================
// メッセージ分析とコンテキスト作成
// =====================================
async function analyzeMessage(message, userId) {
  const context = {
    orderNumber: null,
    orderInfo: null,
    category: null,
    requiresHumanReview: false,
    customerHistory: null,
    customerName: null,
    possibleOrders: null,
    conversationState: null
  };
  
  // 顧客履歴を取得（会話の状態も確認）
  context.customerHistory = await getCustomerHistory(userId);
  context.conversationState = await getConversationState(userId);
  
  // 注文番号の抽出（複数パターンに対応）
  const orderPatterns = [
    /#(\d+)/,                    // #1234
    /注文番号[\s:：]*(\d+)/,     // 注文番号：1234
    /オーダー[\s:：]*(\d+)/,     // オーダー：1234
    /(\d{4,})/                   // 4桁以上の数字
  ];
  
  for (const pattern of orderPatterns) {
    const match = message.match(pattern);
    if (match) {
      context.orderNumber = match[1];
      break;
    }
  }
  
  // 名前の抽出を試みる
  context.customerName = extractCustomerName(message);
  
  // 注文情報を取得
  if (context.orderNumber) {
    context.orderInfo = await getOrderDetails(context.orderNumber);
  } else if (context.customerName) {
    // 名前から注文を検索
    context.possibleOrders = await searchOrdersByCustomerName(context.customerName);
  }
  
  // カテゴリー分類
  context.category = categorizeMessage(message);
  
  // 人間の確認が必要か判定
  context.requiresHumanReview = shouldEscalateToHuman(message, context);
  
  return context;
}

// 会話の状態を管理
const conversationStates = new Map();

async function getConversationState(userId) {
  return conversationStates.get(userId) || { stage: 'initial' };
}

async function updateConversationState(userId, state) {
  conversationStates.set(userId, { ...state, updatedAt: new Date() });
  
  // 30分後に自動クリア
  setTimeout(() => {
    conversationStates.delete(userId);
  }, 30 * 60 * 1000);
}

// 名前を抽出する関数
function extractCustomerName(message) {
  // 「〇〇です」「〇〇と申します」などのパターン
  const namePatterns = [
    /私?は?(.{2,10})(?:です|と申します|といいます)/,
    /名前は(.{2,10})(?:です|と申します)/,
    /(.{2,10})(?:です|と申します|といいます)$/
  ];
  
  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  // 単独の名前（2-4文字の漢字・ひらがな・カタカナ）
  if (/^[ぁ-んァ-ヶー一-龯]{2,4}$/.test(message.trim())) {
    return message.trim();
  }
  
  return null;
}

// 名前から注文を検索
async function searchOrdersByCustomerName(customerName) {
  try {
    // 名前の部分一致で検索（姓または名で検索）
    const searchQueries = [
      customerName,
      customerName.slice(0, -1), // 名前の最後の1文字を除く（「様」などを考慮）
      customerName.slice(1)       // 名前の最初の1文字を除く
    ];
    
    const allOrders = [];
    
    for (const query of searchQueries) {
      const response = await shopifyAxios.get(`/customers/search.json?query=${encodeURIComponent(query)}`);
      
      for (const customer of response.data.customers) {
        // 顧客の注文を取得
        const ordersResponse = await shopifyAxios.get(`/orders.json?customer_id=${customer.id}&status=any&limit=10`);
        allOrders.push(...ordersResponse.data.orders);
      }
    }
    
    // 重複を除去して最新の注文順にソート
    const uniqueOrders = Array.from(
      new Map(allOrders.map(order => [order.id, order])).values()
    ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    return uniqueOrders.slice(0, 5); // 最新5件まで
    
  } catch (error) {
    console.error('顧客名での注文検索エラー:', error);
    return [];
  }
}

// メッセージのカテゴリー分類
function categorizeMessage(message) {
  const categories = {
    '配送・発送': ['発送', '配送', '届', 'いつ', '到着', '追跡'],
    '注文確認': ['注文', '確認', '状況', 'ステータス'],
    'キャンセル・返品': ['キャンセル', '返品', '返金', '交換'],
    '在庫': ['在庫', '入荷', '売り切れ', '再入荷'],
    '商品': ['商品', 'サイズ', '色', '詳細'],
    '支払い': ['支払', '決済', '振込', 'クレジット'],
    '営業・その他': ['営業時間', '休み', '問い合わせ']
  };
  
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => message.includes(keyword))) {
      return category;
    }
  }
  
  return 'その他';
}

// 人間の対応が必要か判定
function shouldEscalateToHuman(message, context) {
  // エスカレーション条件
  const escalationKeywords = ['クレーム', '怒', '最悪', '詐欺', '訴訟', '弁護士'];
  const hasEscalationKeyword = escalationKeywords.some(keyword => message.includes(keyword));
  
  // キャンセル・返品は人間が確認
  const needsHumanCategories = ['キャンセル・返品'];
  const needsHumanReview = needsHumanCategories.includes(context.category);
  
  return hasEscalationKeyword || needsHumanReview;
}

// =====================================
// Shopify連携（詳細版）
// =====================================
async function getOrderDetails(orderNumber) {
  try {
    // 注文番号で検索
    const response = await shopifyAxios.get(`/orders.json?name=${orderNumber}&status=any`);
    
    if (response.data.orders.length === 0) {
      return null;
    }
    
    const order = response.data.orders[0];
    
    // 詳細情報を整理
    return {
      orderNumber: order.order_number,
      status: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      createdAt: order.created_at,
      totalPrice: order.total_price,
      currency: order.currency,
      items: order.line_items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      customer: {
        name: `${order.customer.first_name} ${order.customer.last_name}`,
        email: order.customer.email
      },
      shippingAddress: order.shipping_address,
      trackingInfo: order.fulfillments.map(f => ({
        trackingNumber: f.tracking_number,
        trackingCompany: f.tracking_company,
        trackingUrl: f.tracking_url,
        status: f.status
      }))
    };
  } catch (error) {
    console.error('Shopify注文取得エラー:', error);
    return null;
  }
}

// 顧客履歴を取得
async function getCustomerHistory(userId) {
  try {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        property: '顧客LINE_ID',
        rich_text: {
          contains: userId
        }
      },
      sorts: [
        {
          property: '作成日時',
          direction: 'descending'
        }
      ],
      page_size: 5
    });
    
    return response.results;
  } catch (error) {
    console.error('顧客履歴取得エラー:', error);
    return [];
  }
}

// =====================================
// テンプレート管理
// =====================================
async function loadResponseTemplates() {
  try {
    // キャッシュチェック（5分間有効）
    if (responseTemplates && templateLastUpdated && 
        (Date.now() - templateLastUpdated) < 5 * 60 * 1000) {
      return responseTemplates;
    }
    
    // NotionからテンプレートページのIDを環境変数で指定
    const templatePageId = process.env.NOTION_TEMPLATE_PAGE_ID;
    if (!templatePageId) {
      console.log('テンプレートページIDが設定されていません');
      return getDefaultTemplates();
    }
    
    // Notionからテンプレートを取得
    const response = await notion.blocks.children.list({
      block_id: templatePageId,
      page_size: 100
    });
    
    // テンプレートを解析
    const templates = {};
    let currentCategory = null;
    
    for (const block of response.results) {
      if (block.type === 'heading_2') {
        currentCategory = block.heading_2.rich_text[0]?.plain_text;
      } else if (block.type === 'paragraph' && currentCategory) {
        const text = block.paragraph.rich_text[0]?.plain_text;
        if (text) {
          if (!templates[currentCategory]) {
            templates[currentCategory] = [];
          }
          templates[currentCategory].push(text);
        }
      }
    }
    
    responseTemplates = templates;
    templateLastUpdated = Date.now();
    
    console.log('テンプレート読み込み完了:', Object.keys(templates));
    return templates;
    
  } catch (error) {
    console.error('テンプレート読み込みエラー:', error);
    return getDefaultTemplates();
  }
}

// デフォルトテンプレート
function getDefaultTemplates() {
  return {
    '配送確認': [
      'ご注文番号 #{orderNumber} の配送状況をお調べいたします。',
      '現在の配送状況：{status}',
      '追跡番号：{trackingNumber}',
      'お届け予定日：{deliveryDate}'
    ],
    '注文確認': [
      'ご注文ありがとうございます。',
      '注文番号：#{orderNumber}',
      'ご注文日：{orderDate}',
      '合計金額：¥{totalPrice}'
    ],
    '在庫確認': [
      '在庫状況を確認いたします。',
      '商品名：{productName}',
      '在庫状況：{stockStatus}'
    ],
    'お詫び': [
      'この度はご不便をおかけして申し訳ございません。',
      '早急に確認し、対応させていただきます。'
    ],
    '挨拶': [
      'いらっしゃいませ！本日はどのようなご用件でしょうか？',
      'お問い合わせありがとうございます。'
    ]
  };
}

// =====================================
// ChatGPT応答生成（改善版）
// =====================================
async function generateAIResponse(message, context) {
  try {
    // 会話の状態を取得
    const conversationState = await getConversationState(context.userId);
    
    // テンプレートを読み込み
    const templates = await loadResponseTemplates();
    
    // 発送状況の問い合わせで注文番号がない場合
    if (context.category === '配送・発送' && !context.orderNumber && !context.orderInfo) {
      
      // ステップ1: 名前を聞く
      if (conversationState.stage === 'initial') {
        await updateConversationState(context.userId, { 
          stage: 'waiting_for_name',
          intent: 'shipping_inquiry'
        });
        
        return `発送状況を確認させていただきます📦

お手数ですが、ご注文時のお名前をフルネームで教えていただけますでしょうか？

（例：山田太郎）`;
      }
      
      // ステップ2: 名前から注文を検索
      if (conversationState.stage === 'waiting_for_name' && context.customerName) {
        if (context.possibleOrders && context.possibleOrders.length > 0) {
          
          if (context.possibleOrders.length === 1) {
            // 注文が1件のみの場合
            const order = context.possibleOrders[0];
            await updateConversationState(context.userId, { stage: 'initial' });
            
            return formatOrderStatusMessage(order);
          } else {
            // 複数の注文がある場合
            await updateConversationState(context.userId, { 
              stage: 'waiting_for_order_selection',
              possibleOrders: context.possibleOrders,
              customerName: context.customerName
            });
            
            return `${context.customerName}様のご注文が複数見つかりました。

どちらの注文についてお調べしましょうか？

${context.possibleOrders.map((order, index) => 
  `${index + 1}. 注文番号 #${order.order_number}
   注文日: ${new Date(order.created_at).toLocaleDateString('ja-JP')}
   商品: ${order.line_items[0].name}${order.line_items.length > 1 ? ` 他${order.line_items.length - 1}点` : ''}`
).join('\n\n')}

番号でお答えいただくか、注文番号を教えてください。`;
          }
        } else {
          // 注文が見つからない場合
          await updateConversationState(context.userId, { 
            stage: 'name_not_found',
            attemptedName: context.customerName
          });
          
          return `申し訳ございません。${context.customerName}様のお名前でご注文が見つかりませんでした。

以下をご確認いただけますでしょうか：
・ご注文時と同じお名前（漢字・カナ）でしょうか？
・最近のご注文でしょうか？

もう一度お名前を教えていただくか、注文番号がお分かりでしたら教えてください。`;
        }
      }
      
      // ステップ3: 注文選択待ち
      if (conversationState.stage === 'waiting_for_order_selection') {
        const selection = parseInt(message.trim());
        if (selection && conversationState.possibleOrders && conversationState.possibleOrders[selection - 1]) {
          const selectedOrder = conversationState.possibleOrders[selection - 1];
          await updateConversationState(context.userId, { stage: 'initial' });
          
          return formatOrderStatusMessage(selectedOrder);
        }
      }
    }
    
    // 注文番号がある場合の処理
    if (context.orderInfo) {
      return formatOrderStatusMessage(context.orderInfo);
    }
    
    // カテゴリー別の応答を生成
    const categoryResponses = {
      '配送・発送': () => {
        if (!context.orderNumber) {
          return `発送状況を確認させていただきます📦

ご注文番号、またはご注文時のお名前を教えていただけますでしょうか？`;
        }
        return `注文番号 #${context.orderNumber} の配送状況を確認いたします。少々お待ちください。`;
      },
      
      '在庫': () => {
        return `在庫確認を承りました。

どちらの商品の在庫をお調べいたしましょうか？
商品名またはURLを教えていただけますでしょうか。`;
      },
      
      '営業・その他': () => {
        const businessInfo = `【営業時間のご案内】
平日：9:00-18:00
土日祝：お休み

お電話でのお問い合わせ：
03-1234-5678

メールでのお問い合わせ：
support@hirunegao.com

お急ぎの場合は、お電話でのお問い合わせをお勧めいたします。`;
        
        if (message.includes('営業時間')) {
          return businessInfo;
        }
        
        // 一般的な挨拶への応答
        if (message.match(/こんにち[はわ]|おはよう|こんばん[はわ]|はじめまして/)) {
          return `こんにちは！昼寝のソムリエshop HIRUNEGAOです😊

本日はどのようなご用件でしょうか？
・ご注文の確認
・商品について
・発送状況の確認
・その他のお問い合わせ

お気軽にお申し付けください。`;
        }
        
        return businessInfo;
      },
      
      'キャンセル・返品': () => {
        return `キャンセル・返品についてのお問い合わせですね。

大変恐れ入りますが、キャンセル・返品については担当者が詳細を確認させていただく必要がございます。

以下の情報を教えていただけますでしょうか：
・ご注文番号
・キャンセル/返品の理由

担当者より1営業日以内にご連絡させていただきます。`;
      },
      
      '支払い': () => {
        return `お支払いについてのご案内です💳

【ご利用可能な決済方法】
・クレジットカード（VISA/Master/JCB/AMEX）
・銀行振込
・代金引換（手数料330円）
・コンビニ決済

お支払いに関してご不明な点がございましたら、詳しくお聞かせください。`;
      },
      
      '商品': () => {
        return `商品についてのお問い合わせありがとうございます。

どちらの商品についてお知りになりたいでしょうか？
・商品名
・サイズや仕様
・価格
・在庫状況

具体的な商品名を教えていただければ、詳しくご案内させていただきます。`;
      }
    };
    
    // カテゴリーに応じた応答を取得
    if (categoryResponses[context.category]) {
      const response = categoryResponses[context.category]();
      
      // 顧客履歴がある場合は追加情報
      if (context.customerHistory && context.customerHistory.length > 0) {
        return response + `\n\n※過去にもお問い合わせいただいているお客様ですね。いつもご利用ありがとうございます。`;
      }
      
      return response;
    }
    
    // 通常のChatGPT応答（テンプレートとコンテキストを活用）
    let systemPrompt = `あなたは「昼寝のソムリエshop HIRUNEGAO」の親切で丁寧なカスタマーサポートAIです。

重要：必ず具体的で役立つ情報を提供してください。「担当者より連絡」という回答は最終手段です。

基本ルール：
1. まず、お客様の質問に直接答えられるか判断する
2. 答えられる場合は、具体的な情報を提供する
3. 情報が不足している場合は、必要な情報を聞く
4. 本当に回答できない場合のみ「担当者確認」とする

対応例：
- 「送料は？」→ 具体的な送料を案内
- 「返品したい」→ 返品ポリシーを説明し、必要な情報を聞く
- 「在庫ある？」→ どの商品か聞く
- 「いつ届く？」→ 注文番号か名前を聞く

利用可能なテンプレート：
${JSON.stringify(templates, null, 2)}

カテゴリー: ${context.category}
`;
    
    // ChatGPT APIを呼び出し
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.7,
      max_tokens: 300
    });
    
    let response = completion.choices[0].message.content;
    
    // デフォルト応答を避ける
    if (response.includes('担当者よりご連絡') && !context.requiresHumanReview) {
      // 代わりに役立つ情報を提供
      response = `ご質問ありがとうございます。

もう少し詳しくお聞かせいただけますでしょうか？
例えば：
・ご注文について → 注文番号をお教えください
・商品について → 商品名をお教えください
・配送について → いつ頃のご注文でしょうか

お客様のご要望に合わせてご案内させていただきます😊`;
    }
    
    // 人間の確認が必要な場合は注記を追加
    if (context.requiresHumanReview) {
      response += '\n\n※こちらの件は担当者からも改めてご連絡させていただきます。';
    }
    
    return response;
    
  } catch (error) {
    console.error('応答生成エラー:', error);
    
    // エラー時でも役立つ応答を返す
    const fallbackResponses = {
      '配送・発送': '発送状況の確認には注文番号が必要です。注文番号をお教えいただけますでしょうか？',
      '在庫': '在庫確認をいたします。商品名を教えていただけますでしょうか？',
      '営業・その他': `営業時間：平日9:00-18:00\nお電話：03-1234-5678\nメール：support@hirunegao.com`,
      'キャンセル・返品': '返品は商品到着後7日以内に承っております。注文番号と理由をお教えください。',
      '支払い': 'クレジットカード、銀行振込、代引き、コンビニ決済がご利用いただけます。',
      '商品': 'どちらの商品についてお知りになりたいでしょうか？'
    };
    
    return fallbackResponses[context.category] || 
           'お問い合わせありがとうございます。もう少し詳しくお聞かせいただけますでしょうか？';
  }
}

// 注文状況メッセージのフォーマット
function formatOrderStatusMessage(order) {
  let message = `📦 発送状況のご確認

【ご注文情報】
注文番号: #${order.order_number || order.name}
注文日: ${new Date(order.created_at).toLocaleDateString('ja-JP')}
お客様名: ${order.customer?.first_name} ${order.customer?.last_name} 様

【配送状況】
ステータス: ${getStatusInJapanese(order.fulfillment_status)}
`;

  if (order.fulfillments && order.fulfillments.length > 0) {
    const fulfillment = order.fulfillments[0];
    message += `
【配送詳細】
配送業者: ${fulfillment.tracking_company || '確認中'}
追跡番号: ${fulfillment.tracking_number || '準備中'}`;
    
    if (fulfillment.tracking_url) {
      message += `
追跡URL: ${fulfillment.tracking_url}`;
    }
    
    message += `
発送日: ${new Date(fulfillment.created_at).toLocaleDateString('ja-JP')}
お届け予定: 発送から2-3営業日`;
  } else if (order.fulfillment_status === null) {
    message += `
現在、発送準備中です。
発送が完了しましたら、追跡番号と共にお知らせいたします。`;
  }

  message += `

ご不明な点がございましたら、お気軽にお問い合わせください😊`;

  return message;
}

// =====================================
// Notion保存（改善版）
// =====================================
async function saveToNotion(data) {
  try {
    // IDフィールドの自動生成
    const autoId = Date.now().toString();
    
    const properties = {
      'ID': { 
        title: [{ 
          text: { 
            content: autoId
          } 
        }] 
      },
      '顧客名': { 
        rich_text: [{ 
          text: { content: data.userName || '不明' } 
        }] 
      },
      '顧客LINE_ID': { 
        rich_text: [{ 
          text: { content: data.userId } 
        }] 
      },
      '問い合わせ': { 
        rich_text: [{ 
          text: { content: data.userMessage || '' } 
        }] 
      },
      '作成文章': { 
        rich_text: [{ 
          text: { content: data.aiReply || '' } 
        }] 
      },
      'ステータス': { 
        select: { name: data.status || '対応済み' }
      },
      'プラットフォーム': { 
        select: { name: 'LINE' }
      },
      '作成日時': { 
        rich_text: [{ 
          text: { content: new Date().toLocaleString('ja-JP') } 
        }] 
      }
    };
    
    // 注文番号がある場合のみ追加
    if (data.orderNumber) {
      properties['注文番号'] = { 
        number: parseInt(data.orderNumber)
      };
    }
    
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: properties
    });
    
    console.log('Notionに保存しました:', autoId);
    
  } catch (error) {
    console.error('Notion保存エラー:', error.message);
    throw error; // エラーを上位に伝播
  }
}

// =====================================
// 自動通知機能（改善版）
// =====================================

// 発送通知をチェック（5分ごと）
cron.schedule('*/5 * * * *', async () => {
  console.log('発送状況をチェック中...');
  
  try {
    // 過去24時間の注文を取得
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const response = await shopifyAxios.get(`/orders.json?updated_at_min=${yesterday}&status=any&limit=50`);
    
    for (const order of response.data.orders) {
      // 新しく発送された注文をチェック
      if (order.fulfillment_status === 'fulfilled' && 
          order.tags && 
          !order.tags.includes('line_notified')) {
        
        // 顧客のLINE IDを検索
        const lineUserId = await findLineUserIdByEmail(order.customer.email);
        if (lineUserId) {
          await sendShippingNotification(lineUserId, order);
          
          // 通知済みタグを追加
          await shopifyAxios.put(`/orders/${order.id}.json`, {
            order: { 
              tags: order.tags ? `${order.tags},line_notified` : 'line_notified'
            }
          });
        }
      }
    }
  } catch (error) {
    console.error('発送チェックエラー:', error);
  }
});

// メールアドレスからLINE IDを検索
async function findLineUserIdByEmail(email) {
  try {
    // Notionで顧客メールアドレスを検索
    const response = await notion.databases.query({
      database_id: process.env.NOTION_CUSTOMER_DB_ID, // 顧客マスターDB
      filter: {
        property: 'メールアドレス',
        email: {
          equals: email
        }
      }
    });
    
    if (response.results.length > 0) {
      return response.results[0].properties['LINE_ID']?.rich_text[0]?.plain_text;
    }
    
    return null;
  } catch (error) {
    console.error('LINE ID検索エラー:', error);
    return null;
  }
}

// 発送完了通知を送信
async function sendShippingNotification(userId, order) {
  const tracking = order.fulfillments[0];
  const message = `📦 発送完了のお知らせ

${order.customer.first_name} 様

お待たせいたしました！
ご注文いただいた商品を発送いたしました。

【ご注文内容】
注文番号: #${order.order_number}
${order.line_items.map(item => 
  `・${item.name} × ${item.quantity}`
).join('\n')}

【配送情報】
${tracking?.tracking_company || '配送業者確認中'}
追跡番号: ${tracking?.tracking_number || '準備中'}
${tracking?.tracking_url ? `追跡URL: ${tracking.tracking_url}` : ''}

お届け予定: 2-3営業日

商品の到着まで今しばらくお待ちください。
ご不明な点がございましたら、お気軽にお問い合わせください😊`;
  
  try {
    await lineClient.pushMessage(userId, {
      type: 'text',
      text: message
    });
    console.log('発送通知送信完了:', order.order_number);
  } catch (error) {
    console.error('発送通知送信エラー:', error);
  }
}

// =====================================
// ヘルパー関数
// =====================================

// ステータスを日本語に変換
function getStatusInJapanese(status) {
  const statusMap = {
    null: '処理中',
    'pending': '保留中',
    'fulfilled': '発送済み',
    'partial': '一部発送済み',
    'restocked': '返品済み',
    'paid': '支払い済み',
    'partially_paid': '一部支払い済み',
    'refunded': '返金済み',
    'voided': 'キャンセル済み'
  };
  return statusMap[status] || status || '確認中';
}

// =====================================
// サーバー起動
// =====================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`サーバーが起動しました！ポート: ${port}`);
  console.log('Webhookを待機中...');
  
  // 起動時にテンプレートを読み込み
  loadResponseTemplates().then(() => {
    console.log('初期テンプレート読み込み完了');
  });
});

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.send('LINE Bot is running! 🤖');
});

// 手動でテンプレートをリロード
app.get('/reload-templates', async (req, res) => {
  responseTemplates = null;
  await loadResponseTemplates();
  res.json({ message: 'Templates reloaded', templates: Object.keys(responseTemplates || {}) });
});