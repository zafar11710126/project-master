const Payment = require('./payment');
const router = require('express')();
const Event = require('../events/event');
const Team = require('../teams/teams');
const qs = require('querystring');
const studentAuth = require('../../middleware/studentauth');
const clubAuth = require('../../middleware/clubauth');
const adminAuth = require('../../middleware/adminauth');
const checksum_lib = require('../../checksum/checksum');
const dotenv = require('dotenv');
const https = require('https');

dotenv.config();

port = 3443;
var PaytmConfig = {
    mid: process.env.mid,
    key: process.env.key,
    website: process.env.website
};

router.post('/pay/:teamId/:catId', function (req, res) {
    Team.findOne({ _id: req.params.teamId, "events_participated.cat_id": req.params.catId })
        .then((team) => {
            if (team) {
                Event.findOne({ "categories._id": req.params.catId }, { "categories.$": 1 })
                    .then((event) => {
                        if (event) {
                            var params = {};
                            params['MID'] = PaytmConfig.mid;
                            params['WEBSITE'] = PaytmConfig.website;
                            params['CHANNEL_ID'] = 'WEB';
                            params['INDUSTRY_TYPE_ID'] = 'Retail';
                            params['ORDER_ID'] = 'COLORS_' + new Date().getTime();
                            params['CUST_ID'] = (team._id).toString();
                            params['TXN_AMOUNT'] = (event.categories[0].amount).toString();
                            params['CALLBACK_URL'] = 'https://localhost:' + port + '/payments/pay/' + team._id + '/' + event.categories[0]._id + '/callback';
                            //params['EMAIL'] = 'abc@mailinator.com';
                            //params['MOBILE_NO'] = '7777777777';
                            checksum_lib.genchecksum(params, PaytmConfig.key, function (err, checksum) {

                                var txn_url = "https://securegw-stage.paytm.in/theia/processTransaction"; // for staging
                                // var txn_url = "https://securegw.paytm.in/theia/processTransaction"; // for production

                                var form_fields = "";
                                for (var x in params) {
                                    form_fields += "<input type='hidden' name='" + x + "' value='" + params[x] + "' >";
                                }
                                form_fields += "<input type='hidden' name='CHECKSUMHASH' value='" + checksum + "' >";

                                res.writeHead(200, { 'Content-Type': 'text/html' });
                                res.write('<html><head><title>Merchant Checkout Page</title></head><body><center><h1>Please do not refresh this page...</h1></center><form method="post" action="' + txn_url + '" name="f1">' + form_fields + '</form><script type="text/javascript">document.f1.submit();</script></body></html>');
                                res.end();
                            });
                        }
                        else {
                            return res.status(401).send({ "message": "You cannot pay for this event category" });

                        }

                    })
                    .catch((err) => {
                        console.log(err);
                        return res.status(401).send({ "message": "You cannot pay for this event category" });
                    })
            }
            else {
                return res.status(401).send({ "message": "You cannot pay for this event." });
            }

        })
        .catch((err) => {
            console.log(err);
            return res.status(401).send({ "message": "You cannot pay for this event." });
        })
});


function paymentResponse(req, res, next) {
   // console.log("Payment Response Received");
   // console.log("Body: ");
   // console.log(req.body);
    var checksumhash = req.body.CHECKSUMHASH;
    // console.log("PostData:");
    // console.log(post_data);
    // console.log("Checksum: " + checksumhash);
    var result = checksum_lib.verifychecksum(req.body, PaytmConfig.key, checksumhash);
    req.TAMPERED_FLAG = !result;
    // console.log("result: ");
    // console.log(result);
    req.ORDERID = req.body.ORDERID;
    return next();
}

function paymentStatus(req, res) {
    var paytmParams = {};
    //console.log("Tampered Flag: " + req.TAMPERED_FLAG);
    // console.log("Payment Status");
    paytmParams["MID"] = PaytmConfig.mid;
    paytmParams["ORDERID"] = req.ORDERID;
    checksum_lib.genchecksum(paytmParams, PaytmConfig.key, function (err, checksum) {
        paytmParams["CHECKSUMHASH"] = checksum;
        var post_data = JSON.stringify(paytmParams);

        var options = {
            hostname: 'securegw-stage.paytm.in',
            /* for Production */
            // hostname: 'securegw.paytm.in',
            port: 443,
            path: '/order/status',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': post_data.length
            }
        };
        var response = "";
        var post_req = https.request(options, function (post_res) {
            post_res.on('data', function (chunk) {
                response += chunk;
            });

            post_res.on('end', function () {
                //console.log('Response: ', response);
                let paymentObj = new Payment(JSON.parse(response));
                //console.log(paymentObj);
                paymentObj.teamId = req.params.teamId;
                paymentObj.cat_id = req.params.catId;
                paymentObj.TAMPERED_FLAG = req.TAMPERED_FLAG;
                //console.log(paymentObj.cat_iD);
                Payment.create(paymentObj)
                    .then(response => {
                        // console.log("Team Id:" + req.params.teamId);
                        // console.log("Cat Id:" + req.params.catId);
                        // console.log(response.RESPMSG);
                        if(paymentObj.RESPCODE == "01")
                        Team.findOneAndUpdate({_id:req.params.teamId,"events_participated.cat_id":req.params.catId},
                        {"$set":{"events_participated.$.payment_status":"Paid"}},{new:true})
                        .then((success)=>{
                            console.log(success);
                        })
                        .catch((err)=>{
                            console.log(err);
                        })
                        return res.redirect('/payments/pay/paymentStatus/?orderId=' + paymentObj.ORDERID);
                    })
                    .catch(err => {
                        console.log(err);
                        return res.redirect('/landing');
                    });
            });
        });
        post_req.write(post_data);
        post_req.end();
        //return res.redirect('/landing')
    });
}

router.post('/pay/:teamId/:catId/callback', paymentResponse, paymentStatus);

router.get('/pay/paymentStatus',function(req,res){
    Payment.findOne({ORDERID:req.query.orderId},{RESPMSG:1,STATUS:1})
    .then((success)=>{
        if(!success)
            return res.redirect('/landing');
        let obj = {
            RESPMSG: success.RESPMSG,
            STATUS: success.STATUS
        };
        return res.render("payments/payment",{payment:obj})
    })
    .catch((err)=>{
        console.log(err);
        return res.redirect('/landing');
    });
});

router.get('/studentsPage/success',studentAuth,function(req,res){
    Team.find({"$or":[{"owner_name.regn_no":req.currentUser.regn_no},{"participants.regn_no":req.currentUser.regn_no}]},{_id:1})
    .then((teams)=>{
        let obj = [];
        teams.forEach(function(val){
            obj.push(val._id);
        });
        //return res.status(200).send(obj);
        Payment.find({ teamId: { "$in": obj }, STATUS:"TXN_SUCCESS"},{STATUS:1,BANKNAME:1,PAYMENTMODE:1,TXNAMOUNT:1,cat_id:1,TXNDATE:1})
        .then((payment)=>{
            if (payment)
                return res.render("payments/successPayments", { payments: payment });
            else return res.render("payments/successPayments", { payments: null });
        })
        .catch((err)=>{
            return res.status(401).send({"message":err});
        })
    })
    .catch((err)=>{
        return res.status(500).send({"message":err});
    })
});

router.get('/adminsPage/success',adminAuth,function(req,res){
    Team.find({ }, { _id: 1 })
        .then((teams) => {
            let obj = [];
            teams.forEach(function (val) {
                obj.push(val._id);
            });
            //return res.status(200).send(obj);
            Payment.find({ teamId: { "$in": obj }, STATUS: "TXN_SUCCESS" }, { STATUS:1,BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1 })
                .then((payment) => {
                    if (payment)
                        return res.render("payments/successPayments", { payments: payment });
                    else return res.render("payments/successPayments", { payments: null });
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })
        })
        .catch((err) => {
            return res.status(500).send({ "message": err });
        })
});

router.get('/clubsPage/success',clubAuth,function(req,res){
    Event.find({club_id:req.currentUser._id},{event_name:1,"categories._id":1})
    .then((success)=>{
        let obj = [];
        success.forEach(function(val){
            val.categories.forEach(function(cat){
                obj.push(cat._id);
            });
        });
        Payment.find({ cat_id: { "$in": obj }, STATUS: "TXN_SUCCESS" }, { STATUS :1,BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1 })
            .then((payment) => {
                if (payment)
                    return res.render("payments/successPayments", { payments: payment });
                else return res.render("payments/successPayments", { payments: null });
            })
            .catch((err) => {
                return res.status(401).send({ "message": err });
            })
       
    })
    .catch((err)=>{
        console.log(err);
        return res.status(500).send(err);
    })
});

router.get('/studentsPage/failed', studentAuth, function (req, res) {
    Team.find({ "$or": [{ "owner_name.regn_no": req.currentUser.regn_no }, { "participants.regn_no": req.currentUser.regn_no }] }, { _id: 1 })
        .then((teams) => {
            let obj = [];
            teams.forEach(function (val) {
                obj.push(val._id);
            });
            //return res.status(200).send(obj);
            Payment.find({ teamId: { "$in": obj }, STATUS: "TXN_FAILURE" }, { BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1,STATUS:1 })
                .then((payment) => {
                    if (payment)
                        return res.render("payments/failedPayments", { payments: payment });
                    else return res.render("payments/failedPayments", { payments: null });
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })
        })
        .catch((err) => {
            return res.status(500).send({ "message": err });
        })
});

router.get('/adminsPage/failed', adminAuth, function (req, res) {
    Team.find({}, { _id: 1 })
        .then((teams) => {
            let obj = [];
            teams.forEach(function (val) {
                obj.push(val._id);
            });
            //return res.status(200).send(obj);
            Payment.find({ teamId: { "$in": obj }, STATUS: "TXN_FAILURE" }, { BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1,STATUS:1 })
                .then((payment) => {
                    if (payment)
                        return res.render("payments/failedPayments", { payments: payment });
                    else return res.render("payments/failedPayments", { payments: null });
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })
        })
        .catch((err) => {
            return res.status(500).send({ "message": err });
        })
});

router.get('/clubsPage/failed', clubAuth, function (req, res) {
    Event.find({ club_id: req.currentUser._id }, { event_name: 1, "categories._id": 1 })
        .then((success) => {
            let obj = [];
            success.forEach(function (val) {
                val.categories.forEach(function (cat) {
                    obj.push(cat._id);
                });
            });
            Payment.find({ cat_id: { "$in": obj }, STATUS: "TXN_FAILURE" }, { STATUS:1,BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1 })
                .then((payment) => {
                    if (payment)
                        return res.render("payments/failedPayments", { payments: payment });
                    else return res.render("payments/failedPayments", { payments: null });
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })

        })
        .catch((err) => {
            console.log(err);
            return res.status(500).send(err);
        })
});

router.get('/studentsPage/pending', studentAuth, function (req, res) {
    Team.find({ "$or": [{ "owner_name.regn_no": req.currentUser.regn_no }, { "participants.regn_no": req.currentUser.regn_no }] }, { _id: 1 })
        .then((teams) => {
            let obj = [];
            teams.forEach(function (val) {
                obj.push(val._id);
            });
            //return res.status(200).send(obj);
            Payment.find({ teamId: { "$in": obj }, STATUS: "PENDING" }, { STATUS:1,BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1 })
                .then((payment) => {
                    if (payment)
                        return res.render("payments/pendingPayments", { payments: payment });
                    else return res.render("payments/pendingPayments", { payments: null });
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })
        })
        .catch((err) => {
            return res.status(500).send({ "message": err });
        })
});

router.get('/adminsPage/pending', adminAuth, function (req, res) {
    Team.find({}, { _id: 1 })
        .then((teams) => {
            let obj = [];
            teams.forEach(function (val) {
                obj.push(val._id);
            });
            //return res.status(200).send(obj);
            Payment.find({ teamId: { "$in": obj }, STATUS: "PENDING" }, {STATUS:1, BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1 })
                .then((payment) => {
                    if (payment)
                        return res.render("payments/pendingPayments", { payments: payment });
                    else return res.render("payments/pendingPayments", { payments: null });
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })
        })
        .catch((err) => {
            return res.status(500).send({ "message": err });
        })
});

router.get('/clubsPage/pending', clubAuth, function (req, res) {
    Event.find({ club_id: req.currentUser._id }, { event_name: 1, "categories._id": 1 })
        .then((success) => {
            let obj = [];
            success.forEach(function (val) {
                val.categories.forEach(function (cat) {
                    obj.push(cat._id);
                });
            });
            Payment.find({ cat_id: { "$in": obj }, STATUS: "PENDING" }, { STATUS:1,BANKNAME: 1, PAYMENTMODE: 1, TXNAMOUNT: 1, cat_id: 1, TXNDATE: 1 })
                .then((payment) => {
                    if(payment)
                        return res.render("payments/pendingPayments", { payments: payment });
                    else return res.render("payments/pendingPayments",{payments:null});
                })
                .catch((err) => {
                    return res.status(401).send({ "message": err });
                })

        })
        .catch((err) => {
            console.log(err);
            return res.status(500).send(err);
        })
});

router.get('/viewDetails/:catId/',function(req,res){
    Event.findOne({"categories._id":req.params.catId},{"categories.$":1,event_name:1})
    .then((event)=>{
        return res.status(200).send({"message":event});
    })
    .catch((err)=>{
        return res.status(401).send({"message":err});
    })
})

module.exports = router;