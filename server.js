
var conf = require("nconf");
var fs = require("fs");

var confFile = "config.json";
conf.argv().env().file({ file: confFile});

if(!fs.existsSync(confFile)) {
	conf.set("port", 3000);
	conf.set("game_size", 50000);
	conf.set("player_range", 5000);
	conf.set("skin_amount", 3);
	conf.set("enable_ai", true);
	conf.set("ai_amount", 80);
	conf.set("ai_range", 1000);
	conf.set("bullet_lifelength", 4);
	conf.set("spawn_offset", 8000);
	conf.set("upgrades", {
		"hp_per_sec": 0.5,
		"hp_max_add": 25,
		"bullet_damage": 0.25,
		"bullets_per_round": 50,
		
		"costs": {
			"hp_per_sec": 30,
			"hp_max_add": 40,
			"bullet_damage": 40,
			"bullets_per_round": 30
		}
	});
	conf.save();
}


var port = process.env.PORT || conf.get("port");
var express = require("express");
var exApp = express();
var server = exApp.listen(port);

var socket = require("socket.io");
var io = socket(server);

io.sockets.on("connection", newConnection);

console.log("Started planes server at *:" + port);

// Game static values
var game_ups = 60;
var server_ups = 20;
var mult = Math.floor(game_ups / server_ups);

var bullet_speed = 28 * mult;
var bullet_maxLifeTime = Math.floor(conf.get("bullet_lifelength") * server_ups);

var player_normalSpeed = 11 * mult;
var player_rotSpeed = 3 * mult;
var player_width  = 160;
var player_height = 160;
var player_pointsPerKill = 20;
var player_killstreakTime = 5 * server_ups;
var player_shotWait = Math.floor(server_ups / 20);
var player_reloadInterval = server_ups * 3;
var player_range = conf.get("player_range");

// Upgrade inits
var player_max_hp_init = 100;
var bullet_damage_init = 1;
var bullets_per_round_init = 300;

var spawnOffset = conf.get("spawn_offset");

var ai_range = conf.get("ai_range");
//

var gameSize = conf.get("game_size");
var enableAI = conf.get("enable_ai");
var aiAmount = conf.get("ai_amount");
var bulletOffsets = [ createVector(58, -7), createVector(58, 7) ];

var players = [];
var bullets = [];
var entities = [];

var leaderboard = null;
var leaderboardUpdateTimer = 0;

var aiAmountUpdater = 0;

var ai_nicknames = [];
readLines(fs.createReadStream("ai_nicknames.txt"), function(line) {
	ai_nicknames.push(line);
}, function() {
	for(var i = 0; i < players.length; i++) {
		if(players[i].isAI) {
			players[i].nickname = getRandomNickname();
		}
	}
});


updateAIAmount();
updateLeaderboard();

function newConnection(socket) {
	var player = new NetPlane(socket);
	
	var init_data = {
		bulletOffsets: bulletOffsets,
		bulletLifeLength: bullet_maxLifeTime,
		gameSize: gameSize,
		playerX: Math.floor(random(spawnOffset, gameSize - spawnOffset * 2)),
		playerY: Math.floor(random(spawnOffset, gameSize - spawnOffset * 2))
	}
	
	socket.emit("id", player.id);
	socket.emit("init_data", init_data);
	socket.emit("leaderboard", leaderboard);
	socket.emit("update_upgrades", player.upgrades);
	
	players[players.length] = player;
	
	var ip = socket.request.connection.remoteAddress.substring(7);
	console.log("Player " + player.id + " connected! (" + ip + ")");
	
	socket.on("init_data", initData);
	socket.on("update_data", update);
	socket.on("upgrade_request", upgradeRequest);
	socket.on("disconnect", disconnected);
	
	function initData(data) {
		if(data.nickname == null || data.nickname.length <= 0)
			data.nickname = "No Name";
		
		// Apply initial data
		player.skinid = data.skinid;
		player.nickname = data.nickname;
	}
	
	function upgradeRequest(id) {
		if(id == 0) { // Hp per sec
			if(player.points >= conf.get("upgrades").costs.hp_per_sec) {
				player.points -= conf.get("upgrades").costs.hp_per_sec;
				player.upgrades.hp_per_sec++;
			}
		}else if(id == 1) { // Hp max add
			if(player.points >= conf.get("upgrades").costs.hp_max_add) {
				player.points -= conf.get("upgrades").costs.hp_max_add;
				player.upgrades.hp_max_add++;
			}
		}else if(id == 2) { // Bullet damage
			if(player.points >= conf.get("upgrades").costs.bullet_damage) {
				player.points -= conf.get("upgrades").costs.bullet_damage;
				player.upgrades.bullet_damage++;
			}
		}else if(id == 3) { // Bullets per round
			if(player.points >= conf.get("upgrades").costs.bullets_per_round) {
				player.points -= conf.get("upgrades").costs.bullets_per_round;
				player.upgrades.bullets_per_round++;
			}
		}
		
		socket.emit("update_upgrades", player.upgrades);
	}
	
	function update(data) {
		if(checkValid(data) === false) {
			socket.disconnect();
			console.log("Kicking player " + player.id + " because of suspicious movement!");
			return;
		}
		
		player.x = data.x;
		player.y = data.y;
		player.rotation = data.rotation;
		player.speed = data.speed;
		player.shooting = data.shooting;
		
		// Spawn bullets if shooting
		if(data.shooting) {
			for(var i = 0; i < bulletOffsets.length; i++) {
				var off = getRotatedOffsets(bulletOffsets[i].x, bulletOffsets[i].y, player.rotation);
				var b = new Bullet();
				b.x = player.x + off.x;
				b.y = player.y + off.y;
				b.rotation = player.rotation;
				b.ownerId = player.id;
				b.owner = player;
				b.damage = bullet_damage_init + conf.get("upgrades").bullet_damage * (player.upgrades.bullet_damage - 1);
				bullets[bullets.length] = b;
			}
		}
		
		var self_data = {
			hp: player.hp,
			points: player.points,
			bullets_per_round: player.bullets_per_round
		};
		socket.emit("update_self", self_data);
		
		var sendEntities = [];
		for(var i = 0; i < entities.length; i++) {
			var dst = dist(player.x, player.y, entities[i].x, entities[i].y);
			if(dst < player_range) {
				sendEntities[sendEntities.length] = entities[i].getData();
			}
		}
		socket.emit("entities", sendEntities);
		
		// Send plane object to other players
		var d = player.getData();
		
		for(var i = 0; i < players.length; i++) {
			if(players[i].isAI)
				continue;
			
			var dst = dist(player.x, player.y, players[i].x, players[i].y);
			if(dst < player_range) {
				players[i].socket.emit("plane", d);
			}
		}
		
		if(player.dead) {
			socket.disconnect();
			console.log("Player " + player.id + " died! Kicking him..");
		}
	}
	
	function disconnected() {
		for(var i = 0; i < players.length; i++) {
			if(players[i].id == player.id) {
				players.splice(i, 1);
				break;
			}
		}
		
		console.log("Player " + player.id + " disconnected!");
	}
	
	function checkValid(data) {
		if(player.x == -1 || player.y == -1)
			return true;
		
		var xa = player.x - data.x;
		if(xa < 0) xa = -xa;
		
		var ya = player.y - data.y;
		if(ya < 0) ya = -ya;
		
		var totalSpeed = xa + ya;
		
		var ra = player.rotation - data.rotation;
		if(ra < 0) ra = -ra;
		
		// TODO: Check if new position & rotation is valid!
	}
}

setInterval(update, 1000 / server_ups);
function update() {
	if(enableAI) {
		aiAmountUpdater++;
		aiAmountUpdater %= server_ups * 10;
		if(aiAmountUpdater == 0) {
			updateAIAmount();
		}
	}
	
	for(var i = 0; i < players.length; i++) {
		players[i].update();
	}
	
	for(var i = 0; i < bullets.length; i++) {
		var remove = bullets[i].update();
		if(remove)
			bullets.splice(i--, 1);
	}
	
	leaderboardUpdateTimer++;
	leaderboardUpdateTimer %= server_ups * 2;
	if(leaderboardUpdateTimer == 0 || leaderboard == null) {
		updateLeaderboard();
		io.sockets.emit("leaderboard", leaderboard);
	}
}

function spawnAI() {
	if(enableAI);
		players[players.length] = new PlaneAI();
}

function updateAIAmount() {
	if(players.length < aiAmount) {
		var spawnAmount = aiAmount - players.length;
		for(var i = 0; i < spawnAmount; i++)
			spawnAI();
	}else if(players.length > aiAmount) {
		var removeAmount = players.length - aiAmount;
		var removed = 0;
		for(var i = 0; i < players.length; i++) {
			if(players[i].isAI) {
				removed++;
				players.splice(i--, 1);
			}
			
			if(removed >= removeAmount)
				break;
		}
	}
}

function updateLeaderboard() {
	var lb = [];
	for(var i = 0; i < players.length; i++) {
		lb[i] = players[i];
	}
	
	lb = lb.sort(function(a, b) { return b.points - a.points; });
	lb.length = 10;
	
	leaderboard = [];
	for(var i = 0; i < 10; i++) {
		if(lb[i] == null) {
			leaderboard[i] = null;
			continue;
		}
		
		leaderboard[i] = {
			name:   lb[i].nickname,
			points: lb[i].points
		}
	}
}

function getRandomNickname() {
	var name = ai_nicknames[Math.floor(random(ai_nicknames.length))];
	if(name == null)
		name = "AI Plane";
	else{
		// 50% no uppercase, 50% uppercase
		if(random() < 0.5) {
			name = upperFirstChar(name);
		}
		
		// 20% full uppercase
		if(random() < 0.1) {
			name = name.toUpperCase();
		}
	}
	
	
	return name;
}


function PlaneAI() {
	// Static values
	var reactTime = Math.floor(server_ups * 0.3);
	//
	
	this.id = Math.floor(random(10000000, 9007199254740990));
	this.x = Math.floor(random(spawnOffset, gameSize - spawnOffset * 2));
	this.y = Math.floor(random(spawnOffset, gameSize - spawnOffset * 2));
	this.rotation = Math.floor(random(360));
	this.speed = player_normalSpeed + random(-4, 3);
	this.hp = 100;
	this.shooting = false;
	this.points = 0;
	this.skinid = Math.floor(random(conf.get("skin_amount")));
	this.nickname = getRandomNickname();
	
	var hpPerSecTimer = 0;
	
	var nearestPlane = null;
	var nearTimer = 0;
	var targetRot = 0;
	var lastShot = 0;
	var ammoLeft = 0;
	var reloadTime = 0;
	var shootReact = 0;
	var randomRotTimer = 0;
	var foundRandomRot = false;
	
	this.getData = function() {
		return {
			id: this.id,
			x: this.x,
			y: this.y,
			rotation: this.rotation,
			speed: this.speed,
			hp: this.hp,
			shooting: this.shooting,
			points: this.points,
			skinid: this.skinid,
			nickname: this.nickname
		}
	}
	
	this.update = function() {
		if(Math.floor(this.hp) <= 0) {
			this.hp = 0;
			this.dead = true;
			players.splice(players.indexOf(this), 1);
		}
		
		hpPerSecTimer++;
		hpPerSecTimer %= server_ups;
		if(hpPerSecTimer == 0)
			this.hp += conf.get("upgrades").hp_per_sec;
		if(this.hp > player_max_hp_init) this.hp = player_max_hp_init;
		
		nearTimer++;
		nearTimer %= Math.floor(server_ups * 0.5);
		if(nearTimer == 0)
			this.calculateNearestPlane();
		
		var planeDis = 0;
		if(nearestPlane != null)
			planeDis = dist(this.x, this.y, nearestPlane.x, nearestPlane.y);
		
		if(planeDis > ai_range / 2)
			nearestPlane = null;
		
		if(nearestPlane != null) {
			if(planeDis < 150) {
				if(!foundRandomRot) {
					foundRandomRot = true;
					targetRot = random(360);
				}
			}else{
				foundRandomRot = false;
				targetRot = toDegrees(Math.atan2(nearestPlane.y - this.y, nearestPlane.x - this.x));
			}
			
		}else{
			foundRandomRot = false;
			randomRotTimer++;
			randomRotTimer %= server_ups * 3;
			if(randomRotTimer == 0)
				this.rotation = Math.floor(random(360));
		}
		
		var diff = targetRot - this.rotation;
		while(diff < 0)
			diff += 360;
		while(diff > 360)
			diff -= 360;
		
		if(!(diff < player_rotSpeed || diff > 360 - player_rotSpeed)) {
			if(diff > 180)
				this.rotation -= player_rotSpeed;
			else if(diff < 180)
				this.rotation += player_rotSpeed;
		}
		
		if(reloadTime > 0)
			reloadTime--;
		
		if(lastShot > 0)
			lastShot--;
		
		if(ammoLeft <= 0) {
			ammoLeft = bullets_per_round_init;
			reloadTime = player_reloadInterval;
		}
		
		if(nearestPlane != null) {
			if(planeDis < ai_range / 2) {
				shootReact++;
				if(shootReact > reactTime) {
					if((diff < 20 || diff > 360 - 20) && lastShot == 0 && reloadTime == 0) {
						this.shooting = true;
						
						lastShot = player_shotWait;
						ammoLeft -= bulletOffsets.length;
						
						for(var i = 0; i < bulletOffsets.length; i++) {
							var off = getRotatedOffsets(bulletOffsets[i].x, bulletOffsets[i].y, this.rotation);
							var b = new Bullet();
							b.x = this.x + off.x;
							b.y = this.y + off.y;
							b.rotation = this.rotation;
							b.ownerId = this.id;
							b.owner = this;
							bullets[bullets.length] = b;
						}
					}else
						this.shooting = false;
				}else
					this.shooting = false;
			}else{
				shootReact = 0;
				this.shooting = false;
			}
		}else{
			shootReact = 0;
			this.shooting = false;
		}
		
		var rad = toRadians(this.rotation);
		var xa = Math.cos(rad) * this.speed;
		var ya = Math.sin(rad) * this.speed;
		
		if(this.x + xa > 0 && this.x + xa < gameSize)
			this.x += xa;
		
		if(this.y + ya > 0 && this.y + ya < gameSize)
			this.y += ya;
		
		if(this.x < player_width || this.y < player_height || this.x > gameSize - player_width || this.y > gameSize - player_height) {
			this.hp = 0;
			this.dead = true;
			players.splice(players.indexOf(this), 1);
		}
		
		// Send plane object to other players
		var d = this.getData();
		
		for(var i = 0; i < players.length; i++) {
			if(players[i].isAI)
				continue;
			
			var dst = dist(this.x, this.y, players[i].x, players[i].y);
			if(dst < player_range) {
				players[i].socket.emit("plane", d);
			}
		}
	}
	
	this.onKill = function(player) {
		var plPoints = player.points;
		if(plPoints < 0) plPoints = 0;
		if(plPoints > 500) plPoints = 500;
		
		plPoints = Math.floor(map(plPoints, 0, 500, 0, 30));
		
		this.points += player_pointsPerKill + plPoints;
	}
	
	this.calculateNearestPlane = function() {
		var sw = ai_range / 2;
		var sh = ai_range / 2;
		
		var nearestDis = gameSize * 100;
		for(var i = 0; i < players.length; i++) {
			if(players[i] == this)
				continue;
			
			var dis = dist(this.x, this.y, players[i].x, players[i].y);
			
			if(dis < nearestDis) {
				nearestDis = dis;
				nearestPlane = players[i];
			}
		}
	}
	
	this.isAI = true;
}

var nextPlaneId = 0;
function NetPlane(socket) {
	this.id = nextPlaneId++;
	this.x = -1;
	this.y = -1;
	this.rotation = 0;
	this.speed = 0;
	this.hp = player_max_hp_init;
	this.shooting = false;
	this.points = 0;
	this.skinid = 0;
	this.nickname = "";
	this.bullets_per_round = bullets_per_round_init;
	
	// Upgrades
	this.upgrades = {
		hp_per_sec: 1,
		hp_max_add: 1,
		bullet_damage: 1,
		bullets_per_round: 1
	};
	//
	
	this.dead = false;
	this.socket = socket;
	
	var hpPerSecTimer = 0;
	var killstreakTimer = 0;
	
	this.getData = function() {
		return {
			id: this.id,
			x: this.x,
			y: this.y,
			rotation: this.rotation,
			speed: this.speed,
			hp: this.hp,
			shooting: this.shooting,
			points: this.points,
			skinid: this.skinid,
			nickname: this.nickname
		}
	}
	
	this.update = function() {
		if(this.hp <= 0) {
			this.dead = true;
		}
		
		var maxHp = player_max_hp_init + conf.get("upgrades").hp_max_add * (this.upgrades.hp_max_add - 1);
		hpPerSecTimer++;
		hpPerSecTimer %= server_ups;
		if(hpPerSecTimer == 0)
			this.hp += conf.get("upgrades").hp_per_sec * this.upgrades.hp_per_sec;
		if(this.hp > maxHp) this.hp = maxHp;
		
		if(this.x != -1 && this.y != -1) {
			var w = player_width / 2 + 20;
			var h = player_height / 2 + 20;
			if(this.x < w || this.y < h || this.x > gameSize - w || this.y > gameSize - h) {
				this.hp = 0;
				this.dead = true;
				players.splice(players.indexOf(this), 1);
			}
		}
		
		this.bullets_per_round = bullets_per_round_init + conf.get("upgrades").bullets_per_round * (this.upgrades.bullets_per_round - 1);
	}
	
	this.onKill = function(player) {
		var plPoints = player.points;
		if(plPoints < 0) plPoints = 0;
		if(plPoints > 500) plPoints = 500;
		
		plPoints = Math.floor(map(plPoints, 0, 500, 0, 30));
		
		this.points += player_pointsPerKill + plPoints;
	}
	
	this.isAI = false;
}

var nextBulletId = 0;
function Bullet() {
	this.id = nextBulletId++;
	this.x = -1;
	this.y = -1;
	this.rotation = 0;
	this.ownerId = -1;
	this.owner = null;
	this.damage = bullet_damage_init;
	
	var lifeTime = 0;
	
	this.update = function() {
		lifeTime++;
		
		if(lifeTime > bullet_maxLifeTime)
			return true;
		
		var rad = toRadians(this.rotation);
		var xa = Math.cos(rad) * bullet_speed;
		var ya = Math.sin(rad) * bullet_speed;
		
		this.x += xa;
		this.y += ya;
		
		if(this.x < 0 || this.y < 0 || this.x > gameSize || this.y > gameSize)
			return true;
		
		// Test for collision
		var w = player_width / 2;
		var h = player_height / 2;
		
		for(var i = 0; i < players.length; i++) {
			if(players[i].id == this.ownerId)
				continue;
			
			var x = players[i].x;
			var y = players[i].y;
			
			if(this.x > x - w && this.y > y - h && this.x < x + w && this.y < y + h) {
				if(players[i].dead)
					continue;
				
				players[i].hp -= this.damage;
				if(players[i].hp <= 0) {
					players[i].dead = true;
					if(this.owner != null)
						this.owner.onKill(players[i]);
				}
				
				return true;
			}
		}
	}
}



function getRotatedOffsets(xoff, yoff, rot) {
	var rad = toRadians(rot);
	
	var x = xoff * Math.cos(rad) - yoff * Math.sin(rad);
	var y = xoff * Math.sin(rad) + yoff * Math.cos(rad);
	
	return createVector(x, y);
}

function createVector(x, y) {
	return {
		x: x,
		y: y
	}
}

function toRadians(deg) {
	return deg / 180 * Math.PI;
}

function random(max, min) {
	max = max || 1;
	min = min || 0;
	
	return Math.random() * (max - min) + min;
}

function toDegrees(rad) {
	return rad * 180 / Math.PI;
}

function toRadians(deg) {
	return deg / 180 * Math.PI;
}

function dist(x1, y1, x2, y2) {
	var dst = Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
	if(dst < 0) dst = -dst;
	return dst;
}

function map(n, start1, stop1, start2, stop2) {
	return ((n - start1) / (stop1 - start1)) * (stop2 - start2) + start2;
}

function readLines(input, func, done) {
	var remaining = '';
	
	input.on('data', function(data) {
		remaining += data;
		var index = remaining.indexOf('\n');
		var last  = 0;
		while (index > -1) {
			var line = remaining.substring(last, index);
			last = index + 1;
			func(line);
			index = remaining.indexOf('\n', last);
		}
		
		remaining = remaining.substring(last);
	});
	
	input.on('end', function() {
		if (remaining.length > 0) {
			func(remaining);
		}
		
		done();
	});
}

function upperFirstChar(string) {
	return string.charAt(0).toUpperCase() + string.slice(1);
}