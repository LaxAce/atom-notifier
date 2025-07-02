export const newContestTemplate = (contestTitle: string, newestContestId: string, contestUrl: string) => {

    return (
        `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>New Contest Alert</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <!-- Header -->
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
                        <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">🎯 New Contest Alert</h1>
                        <p style="color: rgba(255, 255, 255, 0.9); margin: 10px 0 0 0; font-size: 16px;">A new naming contest has been posted!</p>
                    </div>
                    
                    <!-- Content -->
                    <div style="padding: 40px 30px;">
                        <div style="background-color: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin-bottom: 30px; border-radius: 0 8px 8px 0;">
                            <h2 style="color: #333; margin: 0 0 15px 0; font-size: 22px; font-weight: 600;">${contestTitle}</h2>
                            <p style="color: #666; margin: 0; font-size: 14px;">Contest ID: ${newestContestId}</p>
                        </div>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${contestUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 25px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease;">🚀 View Contest Details</a>
                        </div>
                        
                        <div style="background-color: #e8f4fd; border: 1px solid #bee5eb; border-radius: 8px; padding: 20px; margin-top: 30px;">
                            <h3 style="color: #0c5460; margin: 0 0 10px 0; font-size: 18px;">💡 Quick Tips</h3>
                            <ul style="color: #0c5460; margin: 0; padding-left: 20px; font-size: 14px;">
                                <li>Review the contest brief carefully</li>
                                <li>Check the deadline and prize amount</li>
                                <li>Submit your best ideas early</li>
                            </ul>
                        </div>
                    </div>
                    
                    <!-- Footer -->
                    <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e9ecef;">
                        <p style="color: #6c757d; margin: 0; font-size: 12px;">This is an automated notification from Atom Notifier by Abdulhafeez</p>
                        <p style="color: #6c757d; margin: 5px 0 0 0; font-size: 12px;">© ${new Date().getFullYear()} Atom Notifier</p>
                    </div>
                </div>
            </body>
            </html>
        `
    )
}

export const newActivityTemplate = (
    ratingType: string,
    submission: string,
    contestUrl: string
) => {
    return (
        `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>New Rating Activity Alert</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <div style="background: linear-gradient(135deg, #43cea2 0%, #185a9d 100%); padding: 30px; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">⭐ New Rating Activity</h1>
                    <p style="color: rgba(255, 255, 255, 0.9); margin: 10px 0 0 0; font-size: 16px;">You have a new rating activity on Atom!</p>
                </div>
                
                <!-- Content -->
                <div style="padding: 40px 30px;">
                    <div style="background-color: #f8f9fa; border-left: 4px solid #43cea2; padding: 20px; margin-bottom: 30px; border-radius: 0 8px 8px 0;">
                        <h2 style="color: #333; margin: 0 0 15px 0; font-size: 22px; font-weight: 600;">A new rating activity was detected.</h2>
                        <p style="color: #666; margin: 0; font-size: 14px;">
                            <b>Rating Type:</b>
                            <span style="color: #185a9d; font-weight: 700; font-size: 16px;">${ratingType}</span><br/>
                            <b>Submission:</b>
                            <span style="color: #43cea2; font-weight: 700; font-size: 16px;">${submission}</span><br/>
                        </p>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${contestUrl}" style="display: inline-block; background: linear-gradient(135deg, #43cea2 0%, #185a9d 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 25px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(67, 206, 162, 0.4); transition: all 0.3s ease;">🔗 View Activity Feed</a>
                    </div>
                </div>
                
                <!-- Footer -->
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e9ecef;">
                    <p style="color: #6c757d; margin: 0; font-size: 12px;">This is an automated notification from Atom Notifier by Abdulhafeez</p>
                    <p style="color: #6c757d; margin: 5px 0 0 0; font-size: 12px;">© ${new Date().getFullYear()} Atom Notifier</p>
                </div>
            </div>
        </body>
        </html>
        `
    )
}