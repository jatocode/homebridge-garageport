const mqttjs = require('mqtt');
const mysql = require('mysql');
const util = require('util');
const io = require('socket.io-client');
let Service, Characteristic, TargetDoorState, CurrentDoorState;

let mqtt;
let db;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  TargetDoorState = Characteristic.TargetDoorState;
  CurrentDoorState = Characteristic.CurrentDoorState;
  homebridge.registerAccessory("homebridge-garageport", "garageport", GarageDoorOpener);
};

class GarageDoorOpener {
  constructor(log, config) {
    this.log = log;
    this.name = config.name;
    this.url = config.url;


    this.currentDoorState = CurrentDoorState.CLOSED;
    this.targetDoorState = TargetDoorState.CLOSED;

    mqtt = mqttjs.connect('mqtt://benchpress.local');
    mqtt.on('connect', () => {
      mqtt.publish('benchpress/homebridge-garageport', new Date().toUTCString(), { qos: 1, retain: true });
      mqtt.subscribe(['garage/esp32/input/#', 'esp32garage'], function (err) {
        if (err) {
          console.error('MQTT subscription failed');
        }
      });
    });

    mqtt.on('message', async function (topic, message) {
      if (topic.startsWith('esp32garage')) {
        let esp32state = JSON.parse(message.toString());
        //console.log(`Got message on topic '${topic}', message: '${message.toString()}'`);
        let status = {
          relayA: esp32state.relayA == "0",
          relayB: esp32state.relayB == "0",
          input1: esp32state.input1 == "0",
          input2: esp32state.input2 == "0",
        }
        this.currentDoorState = status.input2 ? CurrentDoorState.CLOSED : CurrentDoorState.OPEN;
        console.log(new Date().toUTCString() + ' ' + this.currentDoorState);
      }
    });

    this.socket = io(this.url);

    this.socket.on('status', (message) => {
      console.log(message.status);
      let state = message.status.garage === 'open' ? CurrentDoorState.OPEN : CurrentDoorState.CLOSED;
      this.service.setCharacteristic(CurrentDoorState, state);
    });

    this.socket.on('connect', (message) => {
      this.log("Connected to " + this.url);
    });

    setInterval(() => this.socket.emit('status'), 1000);

    let makeDb = function makeDb() {
      const connection = mysql.createConnection({
        host: 'localhost',
        user: 'tobias',
        password: '',
        database: 'hs'
      });
      return {
        query(sql, args) {
          return util.promisify(connection.query)
            .call(connection, sql, args);
        },
        close() {
          return util.promisify(connection.end).call(connection);
        }
      };
    }

    db = makeDb();

  }

  identify(callback) {
    this.log('Identify requested!');
    callback(null);
  }

  openCloseGarage() {
    console.log('websocket request to impulse motor. Publishing to mqtt');
    mqtt.publish('garage/esp32/in', 'G', { qos: 0, retain: false });

  }

  async getGarageState(db) {
    const query = `SELECT status,timestamp from garage ORDER BY timestamp DESC LIMIT 1`;
    try {
      const result = await db.query(query);
      return result.map(r => { return { state: r.status, timestamp: r.timestamp } })[0];
    } catch (err) {
      console.log(err);
      return 'NO DB';
    }
  }

  getServices() {
    const informationService = new Service.AccessoryInformation();

    informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Tobias')
      .setCharacteristic(Characteristic.Model, 'LM60')
      .setCharacteristic(Characteristic.SerialNumber, '000');

    this.service = new Service.GarageDoorOpener(this.name, this.name);
    this.service.setCharacteristic(TargetDoorState, TargetDoorState.CLOSED);
    this.service.setCharacteristic(CurrentDoorState, CurrentDoorState.CLOSED);

    this.service.getCharacteristic(TargetDoorState)
      .on('get', (callback) => {
        callback(null, this.targetDoorState);
      })
      .on('set', (value, callback) => {
        this.targetDoorState = value;
        if (this.targetDoorState === TargetDoorState.OPEN &&
          this.currentDoorState === CurrentDoorState.CLOSED) {
          this.openCloseGarage();
        } else if (this.targetDoorState === TargetDoorState.CLOSED &&
          this.currentDoorState === CurrentDoorState.OPEN) {
          this.openCloseGarage();
        }
        callback();
      });

    this.service.getCharacteristic(CurrentDoorState)
      .on('get', async (callback) => {
        const garage = await this.getGarageState(db);
        console.log('From DB: ' + garage.state);
        this.currentDoorState = garage.state == 0 ? CurrentDoorState.CLOSED : CurrentDoorState.OPEN;
        callback(null, this.currentDoorState);
      })
      .on('set', (value, callback) => {
        console.log('Set status?!');
        //this.currentDoorState = value;
        callback();
      });

    this.service
      .getCharacteristic(Characteristic.Name)
      .on('get', callback => {
        callback(null, this.name);
      });

    return [informationService, this.service];
  }
}

