const fs = require('fs');
const imageSize = require('image-size');
const axios = require('axios-https-proxy-fix');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');
const dotenv = require('dotenv').config({path: './.env'});
const { logger } = require('./modules/logger');
const { shuffle, getRandomInt } = require('./modules/utils');
const { threadId } = require('worker_threads');

const ACTION_DELAY = JSON.parse(process.env.ACTION_DELAY);
const ACCOUNT_DELAY = JSON.parse(process.env.ACCOUNT_DELAY);
const MIX_ACCOUNTS = JSON.parse(process.env.MIX_ACCOUNTS);
const CYCLE_DELAY = JSON.parse(process.env.CYCLE_DELAY);
const FILENAMES = fs.readdirSync('./images');

async function getUserData(body) {
    try {
        const resp = await body.get("https://api.meme.fun/user/me")
        return resp.data
    } catch(e) {return {success: false, err: e}}
}

class Account {
    constructor(token, refreshToken, caId, proxy) {
        this.body = generateReqBody(proxy, token);
        this.proxy = proxy;
        this.refreshToken = refreshToken;
        this.token = token;
        this.caId = caId;
    }

    async init() {
        const userData = await getUserData(this.body);
        if(!userData.username) return {success: false, err: userData};
        this.username = userData.username;
        this.id = userData.id;
        return this;
    }

    async getPosts() {
        try {
            const posts = await this.body.get("https://api.meme.fun/ticker/0x38536cf7f2018ca83fd8728d141aa34a8b7d9aaf637ec895f28e59b478f1436e/posts?sort=recent");
            const filteredPosts = posts.data.posts.filter(post => post.user.id !== this.id && !post.userVote);
    
            if(filteredPosts.length === 0) return {success: false, err: "No posts found"};
            return {success: true, posts: filteredPosts};
        } catch(e) {return {success: false, err: e}}
    }

    async like(post) {
        try {
            const response = await this.body.post(`https://api.meme.fun/ticker/0x38536cf7f2018ca83fd8728d141aa34a8b7d9aaf637ec895f28e59b478f1436e/post/${post.id}/vote`, {upvote: true});
    
            return {success: true, response: response.data};
        } catch(e) {return {success: false, err: e}}
    }

    async postPicture(image) {
        try {
            const formData = new FormData();
            formData.append("file", image.image);
            const resp = await this.body.post("https://api.meme.fun/ticker/0x38536cf7f2018ca83fd8728d141aa34a8b7d9aaf637ec895f28e59b478f1436e/post", formData, {
                headers: {"Content-Type": "multipart/form-data", ...formData.getHeaders()},
            });
    
            return {success: true, id: resp.data.id};
    
        } catch(e) {return {success: false, err: e}}
    }

    async checkToken() {
        try {
            const headers = {
                "Privy-App-Id": "clnjqpsk003stlc0fczrtpy4v",
                "Privy-Ca-Id": this.caId,
                "Privy-Client": "react-auth:1.53.1",
                "Authorization": `Bearer ${this.token}`
            }
            const resp = await this.body.post("https://auth.privy.io/api/v1/sessions", {refresh_token: this.refreshToken}, {headers: headers});

            if(resp.data.token == null) {logger.error(`${this.username} | You have to update token manually`); return {success: false}};

            if(resp.data.token != this.token) {
                logger.info(`${this.username} | Token refreshed to ${resp.data.token}:${resp.data.refresh_token}`);
                this.token = resp.data.token;
                this.refreshToken = resp.data.refresh_token;
                this.body = generateReqBody(this.proxy, this.token);
            }

            return {success: true, token: this.token, refreshToken: this.refreshToken};
        } catch(e) {return {success: false, err: e}}
    }
}

function generateReqBody(proxy, authToken) {

    const reqBody = axios.create({
        "headers": {
            "accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "Origin": "https://meme.fun",
            "Content-Type": "application/json",
            "X-Privy-Token": authToken,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        "timeout": 30000,
        httpsAgent: new SocksProxyAgent(proxy),
    });

    return reqBody;
}

function getImage() {
    try {
        while(true) {
            const filename = FILENAMES[Math.floor(Math.random() * FILENAMES.length)];
            const image = fs.readFileSync(`./images/${filename}`);
            const dimensions = imageSize(image);
            if(dimensions.width < 300 || dimensions.height < 300) continue;
            return {success: true, image: image, filename, dimensions};
        }
    } catch(e) {return {success: false, err: e}}
}

async function generateAccounts(tokens, proxys) {
    try {
        if(tokens.length > proxys.length) throw new Error("Not enough proxys for all accounts.")

        let accounts = [];

        for(i=0; i < tokens.length; i++) {
            const token = tokens[i].split(":");
            const account = new Account(token[0], token[1], token[2], proxys[i]);
            const res = await account.init();
            accounts.push(account);
        }

        return {success: true, accounts}
    } catch(e) {return {success: false, err: e}}
}

async function startCycle(accounts) {
    try {
        let i = 1;
        while(true) {
            logger.info(`Starting cycle #${i}!`);
            accounts = MIX_ACCOUNTS? shuffle(accounts) : accounts;
            for(const account of accounts) {
                logger.info(`${account.username} | Starting cycle #${i}.`);

                const token = await account.checkToken();
                if(!token.success) {logger.warn(`${account.username} | Failed to check token`); continue};

                const image = getImage();
                if(!image.success) {logger.warn(`${account.username} | Failed to get image`); continue};
                
                const post = await account.postPicture(image);
                if(!post.success) {logger.warn(`${account.username} | Failed to post picture`); continue};
                logger.info(`${account.username} | Posted ${image.filename}`);
                await logger.setTimer(getRandomInt(ACTION_DELAY[0], ACTION_DELAY[1]), "until next action.");
                
                const posts = await account.getPosts();
                if(!posts.success) {logger.warn(`${account.username} | Failed to get posts`); continue};
                logger.info(`${account.username} | Starting to like ${posts.posts.length} posts...`)

                for(const post of posts.posts) {
                    await logger.setTimer(getRandomInt(ACTION_DELAY[0], ACTION_DELAY[1]), "until next action.");
                    const like = await account.like(post);
                    if(!like.success) logger.warn(`${account.username} | Failed to like post by ${post.user.username}`);
                    logger.info(`${account.username} | Liked post by ${post.user.username}`);
                }

                logger.success(`${account.username} | Finished cycle #${i}.`);
                await logger.setTimer(getRandomInt(ACCOUNT_DELAY[0], ACCOUNT_DELAY[1]), "until next account.");
            }
            logger.info(`Finished cycle #${i}`);
            await logger.setTimer(getRandomInt(CYCLE_DELAY[0], CYCLE_DELAY[1]), 'until next cycle...')
        }
    } catch(e) {return {success: false, err: e}}
}

async function main() {
    const tokens = fs.readFileSync('./data/accounts.txt').toString().split('\n');
    const proxys = fs.readFileSync('./data/proxys.txt').toString().split('\n');

    const {success, accounts} = await generateAccounts(tokens, proxys);
    if(!success) throw new Error(accounts);

    await startCycle(accounts).then(console.log);
}

main()