const port = 3000;
const mongoUrl = "mongodb://localhost:27017/";

function getDayTimestamp(timestamp) {
    if(timestamp == null) {
        timestamp = Date.now();
    }
    return Math.floor(timestamp / 1000.0 / 60.0 / 60.0 / 24.0);
}

function getMonthTimestamp() {
    let d = new Date();
    return d.getMonth() + d.getFullYear() * 12;
}

const MongoClient = require('mongodb').MongoClient;

MongoClient.connect(mongoUrl,{ useUnifiedTopology: true }, (err, db)=>{
    const dbo = db.db("stecamonitor");

    const express = require("express");
    const app = express();
    const path = require('path');

    //Get collections
    const powerCollection = dbo.collection("power");
    const monthsCollection = dbo.collection("months");
    const daysCollection = dbo.collection("days");

    //Setup indexes
    powerCollection.createIndex("day");
    monthsCollection.createIndex("month");
    daysCollection.createIndex("day");

    app.get("/power", (req, res) =>{
        let day = parseInt(req.query.day);

        if(day == null || isNaN(day)) {
            day = getDayTimestamp();
        }

        let start = Date.now();

        getDayData(day).then((data)=>{
            let diff = Date.now() - start;

            console.log("Lookup in:", diff+"ms");

            res.send(data);
        });
    });

    app.get("/year", (req, res) =>{
        let year = parseInt(req.query.year);

        if(year == null || isNaN(year)) {
            year = new Date().getFullYear();
        }

        monthsCollection.find({month: {$gte: year*12, $lte: year*12+11}}).toArray((err, result)=>{
            res.send(result);
        });
    });

    app.get("/", (req, res) =>{
        res.sendFile(path.join(__dirname + "/index.html"));
    });

    app.listen(port, () => {
        console.log("Server listening on port: ", port);
    });

    const parser = require("fast-xml-parser");
    const http = require("http");

    let lastPower = null;
    let lastTimestamp = null;

    async function findDayWattHours(dayTimestamp) {
        console.log("Finding watthours for day: ", dayTimestamp);

        let promise = new Promise((resolve, reject)=>{
            powerCollection.find({day: dayTimestamp}).toArray((err, result)=>{
                if(err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });

        let wattHoursDay = 0;

        try {
            let result = await promise;

            result.forEach((dayData)=>{
                wattHoursDay += dayData.power;
            });

        } catch(e) {
            console.warn(e);
        }

        return wattHoursDay;
    }

    async function findMonthWattHours(monthTimestamp) {
        const startDate = new Date();
        const endDate = new Date();

        startDate.setFullYear(Math.floor(monthTimestamp / 12));
        startDate.setHours(0, 0, 0);
        startDate.setMonth(monthTimestamp % 12);
        startDate.setDate(1);

        endDate.setFullYear(Math.floor((monthTimestamp+1) / 12));
        endDate.setHours(23,59,59);
        endDate.setMonth((monthTimestamp+1) % 12);
        endDate.setDate(0);

        let startDay = getDayTimestamp(startDate.getTime());
        let endDay = getDayTimestamp(endDate.getTime());

        //Dont allow lookup into the future (Makes no sense)
        endDay = Math.min(getDayTimestamp(), endDay);

        let monthWattHours = 0;

        for(let day = startDay; day<=endDay; day++) {
            monthWattHours += await findDayWattHours(day);
        }
        
        return monthWattHours;
    }

    async function getDayData(dayTimestamp) {
        if(dayTimestamp >= getDayTimestamp()) {
            //Use raw power data, since we still update this day
            return await new Promise((resolve)=>{
                powerCollection.find({day: dayTimestamp}).toArray((err, result)=>{
                    resolve(result);
                });
            });
        } else {
            //Use day data, as this is in the past
            return await new Promise((resolve)=>{
                daysCollection.findOne({day: dayTimestamp}).then((day)=>{
                    if(day == null) {
                        powerCollection.find({day: dayTimestamp}).toArray((err, result)=>{
                            day = {
                                day: dayTimestamp,
                                powerArray: []
                            };

                            let timeMap = new Map();

                            result.forEach((power)=>{
                                let time = Math.floor(power.lastUpdated / 1000.0 / 60.0);
                                let timeEntry = timeMap.get(time);

                                if(timeEntry == null) {
                                    timeEntry = {
                                        day: dayTimestamp,
                                        lastUpdated: power.lastUpdated,
                                        power: 0,
                                        watt: 0,
                                        count: 0
                                    }

                                    timeMap.set(time, timeEntry);
                                }

                                timeEntry.power += power.power;
                                timeEntry.watt += power.watt;
                                timeEntry.count++;
                            });

                            Array.from(timeMap.values()).forEach((entry)=>{
                                entry.watt = entry.watt / entry.count;
                                day.powerArray.push(entry);
                            });

                            daysCollection.insertOne(day).then(()=>{
                                resolve(day.powerArray);
                            });
                        });
                                
                    } else {
                        resolve(day.powerArray);
                    }
                });
            });
        }
    }

    async function getMonthData(monthTimestamp) {
        let month = await monthsCollection.findOne({month: monthTimestamp});

        if(month == null) {
            console.log("Month not found, creating from data");
            month = {
                month: monthTimestamp,
                wattHours: -1
            };

            await monthsCollection.insertOne(month);
        }

        return month;
    }

    function requestData() {
        let start = Date.now();

        http.request({
            host: "10.0.1.161",
            path: "/measurements.xml"
        }, (res)=>{
            let content = "";
            let monthPromise = Promise.resolve();

            res.on("data", (chunk)=>{
                content += chunk;
            });

            res.on("end", ()=>{

                try {
                    let parsedXml = parser.parse(content, {
                        attributeNamePrefix: "",
                        attrNodeName: "attr",
                        ignoreAttributes: false
                    });

                    let power = parsedXml.root.Device.Measurements.Measurement.find((measurement)=>{
                        return measurement.attr.Type === "AC_Power";
                    });

                    if(lastPower != null) {
                        let diff = (Date.now() - lastTimestamp) / 1000.0;

                        let powerAvg = (parseFloat(lastPower.attr.Value) + parseFloat(power.attr.Value)) / 2.0;

                        if(powerAvg > 0) {

                            let wattHours = (powerAvg / diff) / 60.0 / 60.0;

                            const dayTimestamp = getDayTimestamp();

                            let result = {
                                day: dayTimestamp,
                                lastUpdated: Date.now(),
                                power: wattHours,
                                watt: powerAvg
                            };

                            powerCollection.insertOne(result);

                            //Update month
                            const monthTimestamp = getMonthTimestamp();
                            monthPromise = getMonthData(monthTimestamp).then(async (month)=>{
                                let monthWattHours = month.wattHours;
                                if(monthWattHours === -1) {
                                    monthWattHours = await findMonthWattHours(monthTimestamp);
                                } else {
                                    monthWattHours += wattHours;
                                }

                                await monthsCollection.updateOne({month: monthTimestamp}, {$set:{wattHours: monthWattHours}});
                            });
                        }
                    }

                    
                    lastPower = power;
                    lastTimestamp = Date.now();
                } catch(e) {
                    console.error("Something happened trying to parse: ", e);
                }

                monthPromise.then(()=>{
                    let diff = Date.now() - start;
                    console.log("Datarequest:", diff+"ms");
                    setTimeout(()=>{
                        requestData();
                    }, 1000);
                });
            });
        }).end();
    }

    requestData();
});