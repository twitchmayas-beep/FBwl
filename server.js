require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, Events } = require('discord.js');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

// --- CONFIGURATION TWITCH ---
let twitchAccessToken = '';
const GTA_V_GAME_ID = '32982';
const CLIPS_FILE = path.resolve(__dirname, 'Catalogue_RP', 'assets', 'clips_timeline.json');

async function getTwitchToken() {
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }
        });
        twitchAccessToken = response.data.access_token;
        console.log("✅ TOKEN TWITCH ACTUALISÉ");
    } catch (error) {
        console.error("❌ ERREUR TOKEN TWITCH:", error.response?.data || error.message);
    }
}

async function updateClipsTimeline() {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        console.log("⚠️ Identifiants Twitch manquants dans le .env (Saut de la mise à jour des clips)");
        return;
    }
    if (!twitchAccessToken) await getTwitchToken();

    try {
        const charsPath = path.resolve(__dirname, 'Catalogue_RP', 'Characters.json');
        if (!fs.existsSync(charsPath)) {
            console.log("⚠️ Fichier Characters.json introuvable.");
            return;
        }
        
        const characters = JSON.parse(fs.readFileSync(charsPath, 'utf8'));
        const twitchUsernames = [...new Set(characters.map(c => c.twitch).filter(Boolean))];
        
        if (twitchUsernames.length === 0) {
            console.log("ℹ️ Aucun pseudo Twitch trouvé dans les fiches personnages.");
            return;
        }

        const usersRes = await axios.get('https://api.twitch.tv/helix/users', {
            headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${twitchAccessToken}` },
            params: { login: twitchUsernames.slice(0, 100) }
        });
        
        const broadcasterIds = usersRes.data.data.map(u => u.id);
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        
        let allClips = [];
        for (const bId of broadcasterIds) {
            const clipsRes = await axios.get('https://api.twitch.tv/helix/clips', {
                headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${twitchAccessToken}` },
                params: { broadcaster_id: bId, started_at: yesterday, first: 10 }
            });
            const filtered = clipsRes.data.data.filter(clip => clip.game_id === GTA_V_GAME_ID);
            allClips = [...allClips, ...filtered];
        }

        const finalClips = allClips
            .map(c => ({
                id: c.id,
                title: c.title,
                thumbnail_url: c.thumbnail_url,
                embed_url: c.embed_url,
                broadcaster_name: c.broadcaster_name,
                created_at: c.created_at,
                view_count: c.view_count,
                duration: c.duration
            }))
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // 🟢 Système d'Archivage par Jour RP (20h - 06h)
        const archiveDir = path.join(__dirname, 'Catalogue_RP', 'assets', 'archive');
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

        for (const clip of finalClips) {
            const date = new Date(clip.created_at);
            const h = date.getHours();
            
            // On détermine le jour RP (si avant 6h du mat, c'est le jour d'avant)
            const rpDate = new Date(date);
            if (h < 6) rpDate.setDate(rpDate.getDate() - 1);
            
            const fileDate = rpDate.toISOString().split('T')[0];
            const filePath = path.join(archiveDir, `${fileDate}.json`);
            
            let dayClips = [];
            if (fs.existsSync(filePath)) {
                try { dayClips = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) {}
            }
            
            if (!dayClips.find(c => c.id === clip.id)) {
                dayClips.push(clip);
                dayClips.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
                fs.writeFileSync(filePath, JSON.stringify(dayClips, null, 2));
            }
        }

        fs.writeFileSync(CLIPS_FILE, JSON.stringify(finalClips, null, 2));
        console.log(`🎬 Timeline mise à jour : ${finalClips.length} clips RP archivés.`);

    } catch (error) {
        console.error("❌ ERREUR TIMELINE CLIPS:", error.response?.data || error.message);
        if (error.response?.status === 401) twitchAccessToken = '';
    }
}

// 🟢 Routes API pour l'Historique
app.get('/api/archive', (req, res) => {
    const archiveDir = path.join(__dirname, 'Catalogue_RP', 'assets', 'archive');
    if (!fs.existsSync(archiveDir)) return res.json([]);
    
    const files = fs.readdirSync(archiveDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort((a, b) => new Date(b) - new Date(a)); // Plus récent en premier
    
    res.json(files);
});

app.get('/api/archive/:date', (req, res) => {
    const filePath = path.join(__dirname, 'Catalogue_RP', 'assets', 'archive', `${req.params.date}.json`);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("Archive non trouvée.");
    }
});

async function initialClipsUpdate() {
    await getTwitchToken();
    await updateClipsTimeline();
    setInterval(updateClipsTimeline, 3 * 60 * 1000); // 3 minutes
}
initialClipsUpdate();

console.log('🚀 Démarrage du système...');

// 1. Configuration du Bot Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences
    ]
});

client.once(Events.ClientReady, c => {
    console.log(`✅ BOT DISCORD CONNECTÉ : ${c.user.tag}`);
    console.log('==================================================');
    console.log(`🛡️  Système Anti-Streamhack V2 (Opérationnel)`);
    console.log(`🌐  Lien local : http://localhost:${port}`);
    console.log('==================================================');
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
    console.error("❌ ERREUR CONNEXION BOT :", err.message);
});

// 2. Configuration Express
app.use(session({
    secret: 'secret_anti_streamhack_fbwl',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, 'Catalogue_RP')));
app.use('/assets', express.static(path.join(__dirname, 'Catalogue_RP', 'assets')));

// 3. Configuration Passport
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${baseUrl}/auth/discord/callback`,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// --- ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    async (req, res) => {
        try {
            console.log(`\n🔍 Analyse en cours pour : ${req.user.username}`);

            const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
            const member = await guild.members.fetch({ user: req.user.id, force: true });

            const citoyenRoleId = process.env.DISCORD_ROLE_ID_CITOYEN;
            const staffRoleId = process.env.DISCORD_ROLE_ID_STAFF;
            const targetVoiceId = process.env.DISCORD_VOICE_CHANNEL_ID;

            const isCitoyen = member.roles.cache.has(citoyenRoleId);
            const isStaff = member.roles.cache.has(staffRoleId);
            const isInTargetVoice = member.voice.channelId === targetVoiceId;

            console.log(`📊 Stats : Citoyen=${isCitoyen} | Staff=${isStaff} | Vocal=${isInTargetVoice}`);

            const shouldBlock = isCitoyen && isInTargetVoice && !isStaff;

            const webhookURL = process.env.DISCORD_WEBHOOK_URL;
            if (webhookURL) {
                const statusTxt = shouldBlock ? "❌ ACCÈS REFUSÉ" : "✅ ACCÈS AUTORISÉ";
                const embedColor = shouldBlock ? 15548997 : 5763719;

                await axios.post(webhookURL, {
                    embeds: [{
                        title: "🛡️ Gardien Anti-Streamhack",
                        color: embedColor,
                        fields: [
                            { name: "Utilisateur", value: `<@${req.user.id}>`, inline: true },
                            { name: "Verdict", value: `**${statusTxt}**`, inline: true }
                        ],
                        timestamp: new Date()
                    }]
                }).catch(() => { });
            }

            if (shouldBlock) {
                res.redirect('/blocked');
            } else {
                res.redirect('/streams');
            }

        } catch (error) {
            console.error("❌ Erreur:", error.message);
            res.redirect('/streams');
        }
    }
);

app.get('/blocked', (req, res) => {
    res.sendFile(path.join(__dirname, 'blocked.html'));
});

const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.redirect('/');
};

// API pour récupérer le statut Vokal des membres (Présence-IG)
app.get('/api/voice-status', async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        const targetVoiceId = process.env.DISCORD_VOICE_CHANNEL_ID;

        if (!guildId || !targetVoiceId) {
            return res.status(400).json({ error: "Configuration Discord incomplète dans le .env" });
        }

        const guild = await client.guilds.fetch(guildId);
        
        // On récupère les voice states
        const membersInVoice = guild.voiceStates.cache
            .filter(vs => vs.channelId === targetVoiceId)
            .map(vs => vs.id);

        res.json(membersInVoice);
    } catch (error) {
        console.error("❌ Erreur /api/voice-status:", error.message);
        res.status(500).json({ error: "Impossible de récupérer les états vocaux" });
    }
});

app.get('/streams', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'Catalogue_RP', 'Catalogue.html'));
});

app.listen(port, () => {
    console.log(`📡 Serveur prêt.`);
});